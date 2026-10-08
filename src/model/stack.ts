// The Stack view: an ORDERED list of slices of the same thing (versions over time, layers, lanes,
// environments, zoom levels …) as one small interactive plate. Depth always means that order,
// never decoration.
//
// At rest the current slice lies flat and readable (the usual map: cards, wires by source, the
// legend); the other slices sit behind it, visible only as thin stacked edges with a tab each.
// ←/→ (j/k, Home/End, 1–9, a tab) slides to another slice: the stack shifts in depth and the new
// slice comes forward and flattens. `o` fans the whole stack out into an exploded 3D overview (Esc
// or `o` again collapses it). Every slice is drawn at ONE shared layout computed over the union of
// all slices' nodes, so a node sits at the same place on every slice and differences show: the
// legend derives `added here`, `removed here` and `changed here` (vs the previous slice), and what
// disappeared is drawn as a faint ghost on the slice where it went away.
//
// Sheets are real HTML placed in 3D with Space3D (CSS3DRenderer). Tabs, header and legend are
// flat HTML above them, so text is never read in perspective. Wires are drawn on the fx canvas
// over the sheets, projected from each sheet's plane; they fade out in the overview.
import { Scene, Space3D, Morph, Path, ease, clamp, type Frame, type Fx, type SceneClass, type Vals, type P, type KeyHelp } from '../engine';
import { checksFor, type MNode, type Wire } from './model';
import { cardHTML, boxOf, cssId, esc, MAP_CSS, TOP, SIDE } from './scenes';
import { kitsFor, modelStats, type KitSet } from '../kits/registry';
import { arrange, type Arrangement } from './arrange';
import { boardRoute, type Rect, type Slot } from './board-route';
import { LegendStrip, LEGEND_CSS, categorySlots, nodeCategory, litMembers, pinnedMembers, resolveEntry, modelLegend, type LegendEntry } from './legend';
import { outlineTags, highlightEntry, HIGHLIGHT, type PlateOutline } from './outline';
import { stackData, diffMembers, type StackSlice, type SliceView, type StackDiff } from './stack-diff';
import { pickPath } from '../engine/geom';
import { placeCard, warningCardHTML, WIRE_CSS, WIRE_CARD_W } from './wire-info';

export type { StackSlice, StackDiff, WarningItem } from './stack-diff';
export interface StackOpts {
  title?: string;
  /** The line above the title (what the slices are, where they came from). */
  summary?: string;
  /** What one slice is called in the mode line and tooltips (default "slice"; e.g. "commit", "layer"). */
  noun?: string;
  /** The slice the plate rests on (0-based; default the last: the latest version, the deepest layer). */
  rest?: number;
  /** Slices open somewhere else (a splice slice on the board it came from): a click on the current sheet, Enter, or the
   *  toolbar button (its text `label(i)`, its tooltip `hint(i)`) calls `run(i)`. The host decides what that means. */
  open?: { label: (i: number) => string; hint?: (i: number) => string; run: (i: number) => void };
  /** More buttons for the toolbar, after the others (e.g. the host's way out). */
  buttons?: { label: string; title?: string; run: () => void }[];
  /** What each slice is compared with (stack-diff.ts `StackDiff`): `previous` (default) draws what is added, removed and
   *  changed since the slice before (+ − ~ on wires, badges, legend entries, ghosts); `none` draws only each slice's own
   *  `marks`, when they already say what the slice changes against one baseline (a stack of what-ifs). */
  diff?: StackDiff;
  /** What the marks mean, for their legend entries (e.g. proposed: "not in the code yet"); plain defaults otherwise. */
  words?: { proposed?: string; removed?: string; changed?: string };
  /** The kits its node kinds are drawn with (docs/KITS.md); default: the first slice's model's. */
  kits?: KitSet;
  /** A small button in the header after slice i's title (e.g. a combination's ⇄ that swaps its order), or null. */
  headAction?: (i: number) => { label: string; title: string; run: () => void } | null;
  /** A warning item's own button (its `actions`) was pressed: slice i, item k (0-based), the action's id. */
  itemAction?: (i: number, k: number, id: string) => void;
}
export interface StackState {
  /** Index of the current slice. */
  cur: number;
  /** The exploded overview. */
  fan: boolean;
  /** Pinned legend entries (their union is lit). */
  pins: string[];
  /** The legend entry under the pointer (lit at once; part of the state so stills can show it). */
  hover?: string | null;
  /** The slice whose tab is under the pointer (or focused): what it is (`about`) shows beside the tab. */
  tab?: number | null;
  /** The current slice's warning item (0-based) under the pointer (its ⚠, wire, card or list item): its card shows and its
   *  members light, at once. */
  warn?: number | null;
  /** The warning item whose card is pinned (a click on it; Esc or a click elsewhere closes it). */
  warnPin?: number | null;
}
/** What a page can call on a mounted stack (`stage.scene as unknown as StackApi`). */
export interface StackApi {
  /** Slide to slice i (0-based); keeps the overview open if it is. */
  go(i: number): void;
  next(): void;
  prev(): void;
  /** Open or close the exploded overview (toggle when omitted). */
  fan(on?: boolean): void;
  /** Pin exactly this legend entry (`diff:added`, `diff:removed`, `diff:changed`, `cat:<c>`, a derived id); null clears. */
  focusTag(id: string | null): void;
  /** Light exactly these cards (an ad-hoc pin, replacing the others; it survives a slide); null or [] removes it. */
  highlight?(nodeIds: string[] | null): void;
  /** What is on the plate, as plain data (src/model/outline.ts): the current slice's nodes and legend, every slice as a step. */
  describe?(): PlateOutline;
  /** Pin the card of the current slice's warning item `k` (0-based; lit, explained); null closes it. False: no such item. */
  showWarning?(k: number | null): boolean;
}

const DUR = 0.7;
const PEEK = 10;          // px each slice behind shows above the one in front of it
const TAB_H = 26;
const HEAD_H0 = 118;
const LIST_H = 24;        // the header's line of numbered warning items, when a slice has them
const FOOT_H = 150;
const MX = 24;            // sheet inset from the stage edge
const SY0 = TOP - 18;     // layout y that maps to the sheet's top edge
const DIM_PIN = 0.25, DIM_HOVER = 0.22;
const FAN_RX = -62;       // overview: how far each sheet tilts back (deg)
const FRAME = 14;         // a group band's frame reaches this far past its cards (arrange.ts)

/** A polyline without the part inside `r` (the wires are drawn on the fx layer over the HTML, so a card laid over them,
 *  the about card, leaves a hole instead). Each segment is clipped with Liang–Barsky; what is left is split in pieces. */
function cutOut(path: Path, r: { x: number; y: number; w: number; h: number } | null): Path[] {
  if (!r) return [path];
  const out: P[][] = [];
  let cur: P[] = [];
  const pts = path.pts;
  const inside = (q: P) => q.x > r.x && q.x < r.x + r.w && q.y > r.y && q.y < r.y + r.h;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1, hit = true;
    for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]] as const) {
      if (p === 0) { if (q < 0) { hit = false; break; } continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) { hit = false; break; }
    }
    const at = (t: number) => ({ x: a.x + dx * t, y: a.y + dy * t });
    if (!cur.length && !inside(a)) cur.push(a);
    if (!hit || t1 <= t0) { cur.push(b); continue; }
    if (t0 > 0 && cur.length) cur.push(at(t0));
    if (cur.length > 1) out.push(cur);
    cur = t1 < 1 ? [at(t1), b] : [];
  }
  if (cur.length > 1) out.push(cur);
  return out.map((q) => new Path(q));
}

export function stackView(slices0: StackSlice[], o: StackOpts = {}): SceneClass {
  const NODIFF = o.diff === 'none';
  // kit kinds (docs/KITS.md): their cards, sizes and legend entries, and their default categories on every slice
  const kits = o.kits ?? (slices0[0] ? kitsFor(slices0[0].model) : undefined);
  const slices = kits ? slices0.map((s) => ({ ...s, model: kits.decorate(s.model) })) : slices0;
  const { L, views } = stackData(slices, { diff: o.diff, kits });
  const N = views.length;
  const HEAD_H = HEAD_H0 + (views.some((v) => v.slice.warning?.items?.length) ? LIST_H : 0);
  // the rest state is the end: a stack opens on its last slice (the latest version, the deepest layer), unless the
  // host says which one is the picture to start from (a stack of what-ifs rests on the real view)
  const REST = clamp(Math.round(o.rest ?? N - 1), 0, N - 1);
  const blank = (): StackState => ({ cur: REST, fan: false, pins: [], hover: null, tab: null });
  const noun = o.noun ?? 'slice';
  const nouns = noun.endsWith('s') ? noun : `${noun}s`;
  // The plate's geometry follows where the group bands sit (arrange.ts): the page's default, or shelves side by side
  // fitted to the theater's window (`fit`). Everything placed in px derives from one Geo; the rest is fixed.
  // the bands the chrome floor draws `k` times deeper (docs/ENGINE.md "Chrome floor"): the header, the tabs, the foot. A
  // plate laid out for its chrome (`fit`'s `o.chrome`) leaves them that much room, so no sheet is under them at fit.
  const bandsAt = (k: number) => {
    const head = HEAD_H * k, tab = TAB_H * k, foot = FOOT_H * k;
    return { k, head, tab, foot, sheetY: head + (N - 1) * PEEK + tab + 4, fanTop: head + tab };
  };
  type Bands = ReturnType<typeof bandsAt>;
  const FAN_CAM = { yaw: -12, pitch: 3 };
  // the plate around the arranged content: sheet width = the content + SIDE, sheet height = the content + 24 below it
  // (and never less than the layout's own minimum), header and tabs above, the foot (legend, mode line) docked below
  const arrangeOpts = (b: Bands) => ({ wires: L.wires, padRight: SIDE - FRAME, padBottom: b.sheetY - SY0 + 24 + b.foot, minW: 960, minH: b.sheetY + Math.max(240, 480 - 40 - SY0) + b.foot });
  const B1 = bandsAt(1);
  const DEFAULT = arrange(L, null, arrangeOpts(B1));
  const bandOf = (n: MNode) => (n.kind === 'actor' ? '·outside' : n.group ?? 'other');
  const firstOf = new Map(L.groups.map((g) => [g.id, L.nodes.find((n) => bandOf(n) === g.id)!.id]));
  interface Geo {
    key: string; W: number; H: number;
    /** The chrome bands' depths it leaves room for (the chrome floor's boost `k`). */
    b: Bands;
    /** Sheet size, tab width, world y of the flat sheet's centre (+y up). */
    SW: number; SH: number; TW: number; CY0: number;
    /** Overview: the sheets scaled down and tilted back, one above the other in slice order (the scale is measured: fitFan). */
    FAN_BOT: number; GAP: number; FAN_S_MAX: number;
    /** Where every card rests (layout px) and each group band's frame, moved with its cards. */
    pos: Map<string, Slot>;
    groups: Map<string, { x: number; y: number; w: number; h: number }>;
    /** Wire geometry in sheet-local px, once per relationship (one wire per ordered pair, the same on every slice). */
    paths: Map<string, Path>;
  }
  const geoOf = (r: { a: Arrangement; W: number; H: number }, b: Bands): Geo => {
    const { a, W, H } = r, SW = W - 2 * MX, SH = H - b.sheetY - b.foot, FAN_BOT = b.sheetY + SH - 12;
    const groups = new Map(L.groups.map((g) => {
      const id = firstOf.get(g.id)!, p = a.pos.get(id)!, q = L.pos.get(id)!;
      return [g.id, { x: g.x + p.x - q.x, y: g.y + p.y - q.y, w: g.w, h: g.h }];
    }));
    return {
      key: `${a.key}@${W}x${H}@${b.k}`, W, H, b, SW, SH, TW: clamp((SW - 28) / N - 6, 110, 270 * b.k), CY0: H / 2 - (b.sheetY + SH / 2),
      FAN_BOT, GAP: (FAN_BOT - b.fanTop) / N, FAN_S_MAX: Math.min(0.58, (W - 2 * 170) / SW), pos: a.pos, groups, paths: new Map(),
    };
  };
  const GEO0 = geoOf(DEFAULT, B1);
  const W = GEO0.W, H = GEO0.H;

  // categories keep one colour across every slice
  const allNodes = new Map<string, MNode>();
  for (const v of views) for (const n of [...v.nodes, ...v.ghostNodes]) allNodes.set(n.id, n);
  const cats = [...new Set([...allNodes.values()].map(nodeCategory).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
  const slots = categorySlots(cats);

  // wire geometry: the map's router while both ends keep their places relative to each other, else routed around the
  // other cards (the board's rule, board-route.ts); in the default arrangement that is always the map's router
  const localPath = (g: Geo, e: Pick<Wire, 'key' | 'from' | 'to'>): Path => {
    const hit = g.paths.get(e.key);
    if (hit) return hit;
    const pa = g.pos.get(e.from)!, pb = g.pos.get(e.to)!, oa = L.pos.get(e.from)!, ob = L.pos.get(e.to)!;
    const rect = (id: string): Rect => { const p = g.pos.get(id)!; return { x: p.x, y: p.y, ...boxOf(L, id) }; };
    const together = Math.abs(pa.x - oa.x - (pb.x - ob.x)) < 0.5 && Math.abs(pa.y - oa.y - (pb.y - ob.y)) < 0.5;
    const p = together ? boardRoute(rect(e.from), rect(e.to), { a: pa, b: pb })
      : boardRoute(rect(e.from), rect(e.to), undefined, [...g.pos.keys()].filter((id) => id !== e.from && id !== e.to).map(rect));
    const out = new Path(p.pts.map((q) => ({ x: q.x - MX, y: q.y - SY0 })));
    g.paths.set(e.key, out);
    return out;
  };
  const label = (id: string) => allNodes.get(id)?.label ?? id;

  // ---- what a what-if does on a slice (its marks), and what a slice warns about
  const nodeMark = (i: number, id: string) => views[i]!.slice.marks?.nodes[id] ?? null;
  const edgeMark = (i: number, key: string) => views[i]!.slice.marks?.edges[key] ?? null;
  const gone = (i: number, key: string) => { const m = edgeMark(i, key); return m === 'removed' || m === 'rerouted'; };
  const warnNodes = views.map((v) => new Set(v.slice.warning?.nodes ?? []));
  const warnPairs = views.map((v) => new Set(v.slice.warning?.pairs ?? []));
  /** Per slice, the marks' legend entries (as the board's open splice has them) and the warning's; with the wires each lights. */
  const markEntries = views.map((v, i): { entries: LegendEntry[]; keys: [string, Set<string>][] } => {
    const mk = v.slice.marks, entries: LegendEntry[] = [], keys: [string, Set<string>][] = [];
    const wires = new Map([...v.wires].map((w) => [w.key, w]));
    const ends = (ks: string[]) => ks.flatMap((k) => { const w = wires.get(k); return w && !mk?.nodes[w.from] && !mk?.nodes[w.to] ? [w.from, w.to] : []; });
    const allEnds = (ks: string[]) => ks.flatMap((k) => { const w = wires.get(k); return w ? [w.from, w.to] : []; });
    const add = (e: Omit<LegendEntry, 'members' | 'kind'> & { kind?: LegendEntry['kind'] }, ns: string[], ks: string[], members = [...ns, ...ends(ks)]) => {
      if (!ns.length && !ks.length && !(e.id.startsWith('slice:warning') && e.count)) return;
      entries.push({ kind: 'splice', count: ns.length + ks.length, ...e, members: [...new Set(members)] });
      keys.push([e.id, new Set(ks)]);
    };
    // the key: each mark with its sample and what it means (the host's words, else plain ones)
    if (mk) {
      const ns = (ms: string[]) => Object.entries(mk.nodes).filter(([id, m]) => ms.includes(m) && v.nodes.some((n) => n.id === id)).map(([id]) => id);
      const ks = (ms: string[]) => Object.entries(mk.edges).filter(([k, m]) => ms.includes(m) && wires.has(k)).map(([k]) => k);
      const W = { proposed: o.words?.proposed ?? 'not real yet', removed: o.words?.removed ?? `ghost: removed or rerouted on this ${noun}`, changed: o.words?.changed ?? `renamed or moved on this ${noun}` };
      add({ id: 'splice:proposed', name: 'proposed', sample: 'proposed', meaning: W.proposed, hint: `proposed: ${W.proposed}` }, ns(['proposed']), ks(['proposed']));
      add({ id: 'splice:removed', name: 'removed', sample: 'removed', meaning: W.removed, hint: `removed: ${W.removed}` }, ns(['removed']), ks(['removed', 'rerouted']));
      add({ id: 'splice:changed', name: 'renamed / moved', sample: 'changed', meaning: W.changed, hint: `renamed / moved: ${W.changed}` }, ns(['renamed', 'moved']), []);
    }
    const w = v.slice.warning;
    if (w) {
      const name = w.name ?? 'warning', its = w.items ?? [];
      const ns = (xs: string[] | undefined) => (xs ?? []).filter((id) => v.nodes.some((n) => n.id === id)), ks = (xs: string[] | undefined) => (xs ?? []).filter((k) => wires.has(k));
      const kinds = [...new Set(its.map((it) => it.name ?? name))];
      if (kinds.length <= 1 && its.every((it) => (it.tone ?? 'warn') === 'warn')) {
        // the warning lights every card it concerns, both ends of every relationship included
        add({ id: 'slice:warning', name, sample: 'warn', ...(w.meaning ? { meaning: w.meaning } : {}), hint: `⚠ ${name}${w.meaning ? `: ${w.meaning}` : ''} · ${w.text}`, ...(its.length ? { count: its.length } : {}) },
          ns(w.nodes), ks(w.pairs), [...ns(w.nodes), ...allEnds(ks(w.pairs))]);
      } else {
        // items of several kinds (a conflict, an agreement …): one key entry each, its sample by its tone, lighting its items
        for (const kn of kinds) {
          const g = its.filter((it) => (it.name ?? name) === kn), f = g[0]!, tone = f.tone ?? 'warn', mean = f.meaning ?? (kn === name ? w.meaning : undefined);
          const gn = [...new Set(g.flatMap((it) => it.nodes ?? []))], gp = [...new Set(g.flatMap((it) => it.pairs ?? []))];
          // several kinds: names only on the chips (the meaning is in the chip's tooltip and each item's card), so the key fits one row
          add({ id: kn === name ? 'slice:warning' : `slice:warning:${kn}`, name: kn, sample: tone === 'warn' ? 'warn' : tone, ...(mean && kinds.length < 2 ? { meaning: mean } : {}), hint: `${f.sym ?? '⚠'} ${kn}${mean ? `: ${mean}` : ''}`, count: g.length, ...(f.sym ? { glyph: f.sym } : {}) },
            ns(gn), ks(gp), [...ns(gn), ...allEnds(ks(gp))]);
        }
      }
      // each numbered item on its own (not drawn in the strip: the header lists them)
      its.forEach((it, k) => add({ id: `warn:${k + 1}`, name: `⚠ ${name} ${k + 1}: ${it.title}`, kind: 'derived', hint: it.result ?? it.title }, ns(it.nodes), ks(it.pairs), [...ns(it.nodes), ...allEnds(ks(it.pairs))]));
    }
    return { entries, keys };
  });
  /** Per slice: its warning's numbered items (none: []). */
  const itemsOf = views.map((v) => v.slice.warning?.items ?? []);
  /** Per slice: which items each warned relationship and card belongs to. */
  // (a quiet note is reached from its list item only, never by pointing at its cards or wires)
  const itemsByPair = itemsOf.map((its) => { const m = new Map<string, number[]>(); its.forEach((it, k) => { if (it.tone !== 'note') for (const p of it.pairs ?? []) (m.get(p) ?? m.set(p, []).get(p)!).push(k); }); return m; });
  const itemsByNode = itemsOf.map((its) => { const m = new Map<string, number[]>(); its.forEach((it, k) => { if (it.tone !== 'note') for (const n of it.nodes ?? []) (m.get(n) ?? m.set(n, []).get(n)!).push(k); }); return m; });

  // ---- legend entries per slice: categories, the diff vs the previous slice, what the model says
  const counts = (v: SliceView) => ({ add: v.diff.addedNodes.length + v.diff.addedPairs.length, rem: v.diff.removedNodes.length + v.diff.removedPairs.length, chg: v.diff.changedNodes.length + v.diff.changedPairs.length });
  const diffKeys: Map<string, Set<string>>[] = [];
  const entriesOf: LegendEntry[][] = views.map((v, i) => {
    const catEntries: LegendEntry[] = cats.filter((c) => slots.get(c)! > 0).map((c) => ({ id: `cat:${c}`, name: c, kind: 'category', slot: slots.get(c)!, members: v.nodes.filter((n) => nodeCategory(n) === c).map((n) => n.id), hint: `category ${c}` }));
    const other = cats.filter((c) => slots.get(c) === 0);
    if (other.length) catEntries.push({ id: 'cat:·other', name: 'other', kind: 'category', slot: 0, members: v.nodes.filter((n) => other.includes(nodeCategory(n) ?? '')).map((n) => n.id), hint: `categories ${other.join(', ')}` });
    const dm = diffMembers(v.diff);
    const prev = i > 0 ? `${noun} ${i} (${slices[i - 1]!.title})` : '';
    const vs = (what: string) => (v.diff.first ? `the first ${noun}: nothing to compare` : `${what} since ${prev}`);
    const diff: LegendEntry[] = NODIFF ? [] : [
      { id: 'diff:added', name: 'added here', kind: 'derived', members: dm.added.nodes, hint: vs('cards and wires new') },
      { id: 'diff:removed', name: 'removed here', kind: 'derived', members: dm.removed.nodes, hint: vs('cards and wires gone (drawn as ghosts)') },
      { id: 'diff:changed', name: 'changed here', kind: 'derived', members: dm.changed.nodes, hint: vs('cards and wires changed (e.g. where they are known from)') },
    ];
    diffKeys[i] = new Map([['diff:added', new Set(dm.added.pairs)], ['diff:removed', new Set(dm.removed.pairs)], ['diff:changed', new Set(dm.changed.pairs)], ...markEntries[i]!.keys]);
    const model = v.slice.model;
    const ml = modelLegend({
      nodes: v.nodes, wires: v.wires, groups: [], groupOf: () => '', groupName: (g) => g,
      warned: new Set(v.nodes.filter((n) => checksFor(model, n.id).some((c) => c.level === 'warn')).map((n) => n.id)),
      kindEntry: (k) => (kits?.kind(k) ? { name: kits.plural(k), glyph: kits.glyph(k) } : null),
    });
    return [...catEntries, ...ml.kinds, ...markEntries[i]!.entries, ...diff, ...ml.derived];
  });

  // ---- one sheet per slice
  // one small glyph mid-wire on each relationship that changed here (−, +, ~)
  // (a relationship the slice's warning concerns carries ⚠ instead, and its tooltip says both)
  const edgeMarks = (v: SliceView, i = views.indexOf(v)) => {
    const diff = NODIFF ? [] : [
      ...v.diff.removedPairs.map((e) => ({ e, sym: '−', tip: 'removed here', warn: false })),
      ...v.diff.addedPairs.map((e) => ({ e, sym: '+', tip: 'added here', warn: false })),
      ...v.diff.changedPairs.map((c) => ({ e: c, sym: '~', tip: c.what.join('; '), warn: false })),
    ];
    const warned = [...warnPairs[i]!].map((k) => v.wires.find((w) => w.key === k)).filter((w): w is Wire => !!w)
      .map((e) => ({ e, sym: '⚠', warn: true, tip: [`⚠ ${v.slice.warning!.name ?? 'warning'}`, ...diff.filter((d) => d.e.key === e.key).map((d) => d.tip)].join('; ') }));
    return [...diff.filter((d) => !warnPairs[i]!.has(d.e.key)), ...warned].map((m) => ({ ...m, key: m.e.key, u: 0.5, tip: `${label(m.e.from)} → ${label(m.e.to)}: ${m.tip}` }));
  };
  const pairOf = new Map<string, Pick<Wire, 'key' | 'from' | 'to'>>();
  for (const v of views) for (const e of [...v.wires, ...v.ghostWires]) pairOf.set(e.key, e);
  /** Per slice: every card a diff entry names (outlined in the overview, where glyphs are too small to read). */
  const diffNodes = views.map((v, i) => {
    if (NODIFF) return new Set([...Object.keys(v.slice.marks?.nodes ?? {}), ...warnNodes[i]!]);
    const d = diffMembers(v.diff); return new Set([...d.added.nodes, ...d.removed.nodes, ...d.changed.nodes]);
  });
  /** Per slice: where along each marked wire its glyph sits (the wire leaves a gap there). */
  const markAt = views.map((v) => new Map(edgeMarks(v).map((m) => [m.key, m.u])));
  const sheetHTML = (v: SliceView, i: number) => {
    const shown = new Set([...v.nodes, ...v.ghostNodes].map((n) => n.id));
    const groups = L.groups.filter((g) => L.nodes.some((n) => shown.has(n.id) && (n.kind === 'actor' ? '·outside' : n.group ?? 'other') === g.id));
    const changed = new Map(v.diff.changedNodes.map((c) => [c.id, c.what]));
    const added = new Set(v.diff.addedNodes);
    const card = (n: MNode, ghost: boolean) => {
      // what a what-if does to it says more than the diff with the neighbouring slice, so its mark wins the badge
      const mk = ghost ? null : nodeMark(i, n.id);
      const badge = mk ? `<span class="st-badge mk ${mk}" title="${esc(`${mk} on this ${noun}`)}">${mk}</span>`
        : ghost ? `<span class="st-badge rem" title="removed here">− removed</span>`
        : added.has(n.id) ? `<span class="st-badge add" title="added here">+ added</span>`
          : changed.has(n.id) ? `<span class="st-badge chg" title="${esc(changed.get(n.id)!.join('; '))}">~ changed</span>` : '';
      const slot = nodeCategory(n) ? slots.get(nodeCategory(n)!) : undefined;
      const kx = kits && { kits, stats: modelStats(v.slice.model) };
      // a node with no code reference (a hand-written or non-code model) shows its summary, not "declared elsewhere"
      const html = !n.ref && n.summary && n.kind !== 'external' && n.kind !== 'actor'
        ? cardHTML({ ...n, ref: { file: '' } }, kx).replace(/<div class="mm-ref"[^>]*>[^<]*<\/div>/, `<div class="mm-ref" title="${esc(n.summary)}">${esc(n.summary)}</div>`)
        : cardHTML(n, kx);
      return html
        .replace(`id="${cssId(n.id)}"`, `id="s${i}-${cssId(n.id)}" data-node="${esc(n.id)}"${slot !== undefined ? ` data-cat="${slot}"` : ''}`)
        .replace('class="pl-card', `class="pl-card st-card${ghost || mk === 'removed' ? ' is-ghost' : ''}${mk ? ` mk-${mk}` : ''}${warnNodes[i]!.has(n.id) ? ' is-warn' : ''}`)
        .replace(/<span class="mm-lang">/, `${badge}<span class="mm-lang">`)
        .replace(/<\/div>$/, n.kind === 'actor' && badge ? `<span class="st-badges">${badge}</span></div>` : '</div>');
    };
    return `<section class="st-sheet" id="st-sheet-${i}" data-i="${i}" aria-label="${esc(`${noun} ${i + 1}: ${v.slice.title}`)}"><div class="st-body">
      ${groups.map((g) => `<div class="mm-group" data-g="${esc(g.id)}"><span class="pl-label">${esc(g.label)}</span></div>`).join('')}
      ${v.ghostNodes.map((n) => card(n, true)).join('')}
      ${v.nodes.map((n) => card(n, false)).join('')}
      ${edgeMarks(v, i).map((m) => (m.warn
        ? `<span class="st-mark is-warn" data-key="${esc(m.key)}" data-u="${m.u}" data-warn="${(itemsByPair[i]!.get(m.key) ?? []).join(' ')}" role="button" aria-label="${esc(m.tip)}">${m.sym}</span>`
        : `<span class="st-mark" data-key="${esc(m.key)}" data-u="${m.u}" title="${esc(m.tip)}">${m.sym}</span>`)).join('')}
    </div></section>`;
  };

  // scene CSS is global to the page: anything that differs between two stacks on one page goes inline
  const CSS = /* css */ `
    .st-head { position: absolute; left: ${SIDE}px; top: 28px; right: 240px; display: grid; gap: 6px; z-index: 6; }
    .st-now { font: 13px/1.3 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-now b { color: var(--pl-fg); font-weight: 600; }
    .st-toolbar { position: absolute; right: ${SIDE}px; top: 36px; display: flex; gap: 8px; z-index: 6; }
    .st-btn { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 7px 10px; cursor: pointer; white-space: nowrap; }
    .st-btn:hover:not(:disabled) { border-color: var(--pl-fg); }
    .st-btn:disabled { opacity: 0.4; cursor: default; }
    .st-btn[aria-pressed="true"] { border-color: var(--pl-accent); color: var(--pl-accent); }
    .plate-dom button:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .st-sheet { box-sizing: border-box; background-color: color-mix(in srgb, var(--pl-card) 40%, var(--pl-bg)); background-image: radial-gradient(color-mix(in srgb, var(--pl-line) 60%, transparent) 1px, transparent 1.3px); background-size: 24px 24px; border: 1px solid var(--pl-card-border); border-radius: calc(var(--pl-radius) + 4px); box-shadow: var(--pl-shadow); }
    .st-sheet.is-back { cursor: pointer; }
    .st-sheet.is-back:hover { border-color: var(--pl-fg); }
    .st-sheet.is-cur.is-fan { border-color: var(--pl-accent); }
    .st-body { position: absolute; inset: 0; opacity: var(--c, 1); }
    .st-card .mm-top { justify-content: flex-start; }
    .st-card .mm-lang { margin-left: auto; }
    .st-card .mm-top .st-badge { margin-left: 6px; }
    .st-badges { position: absolute; top: -10px; right: 12px; display: flex; gap: 4px; }
    .st-badge { font: 600 10px/1 var(--pl-font-mono); padding: 3px 6px; border-radius: 999px; white-space: nowrap; background: var(--pl-card); }
    .st-badge.add { background: var(--pl-accent); color: var(--pl-card); }
    .st-badge.chg { border: 1px solid var(--pl-accent); color: var(--pl-accent); }
    .st-badge.rem { border: 1px dashed var(--pl-muted); color: var(--pl-muted); }
    .st-sheet.is-fan .st-card.is-diff { border-color: var(--pl-accent); box-shadow: 0 0 0 2px var(--pl-accent); }
    .mm-card.is-ghost { background: transparent; border-style: dashed; box-shadow: none; }
    .mm-card.is-ghost > :not(.st-badges), .mm-card.is-ghost .mm-top > :not(.st-badge) { opacity: 0.5; }
    .mm-card.is-ghost > .mm-top { opacity: 1; }
    .st-mark { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; box-sizing: border-box; display: grid; place-items: center; font: 700 12px/1 var(--pl-font-mono); border-radius: 50%; background: var(--pl-card); border: 1px solid var(--pl-accent); color: var(--pl-accent); z-index: 2; cursor: default; }
    .st-tab { position: absolute; left: 0; top: 0; height: calc(${TAB_H}px * var(--st-k, 1)); box-sizing: border-box; display: flex; align-items: center; gap: calc(7px * var(--st-k, 1)); padding: 0 calc(10px * var(--st-k, 1)); font: calc(12px * var(--st-k, 1))/1 var(--pl-font-mono); color: var(--pl-muted); background: color-mix(in srgb, var(--pl-card) 40%, var(--pl-bg)); border: 1px solid var(--pl-card-border); border-bottom-color: transparent; border-radius: min(var(--pl-radius), 8px) min(var(--pl-radius), 8px) 0 0; cursor: pointer; z-index: 5; text-align: left; }
    .st-tab .n { flex: none; font-weight: 600; }
    .st-tab .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-tab .d { flex: none; font-size: calc(10px * var(--st-k, 1)); letter-spacing: 0.02em; }
    .st-tab:hover { color: var(--pl-fg); }
    .st-tab.is-cur { color: var(--pl-fg); border-top: 2px solid var(--pl-accent); }
    .st-tab.is-cur .n { color: var(--pl-accent); }
    .st-tab.is-float { border-bottom-color: var(--pl-card-border); border-radius: min(var(--pl-radius), 8px); }
    .st-foot { position: absolute; left: ${SIDE}px; right: ${SIDE}px; bottom: 16px; height: ${FOOT_H - 30}px; box-sizing: border-box; border-top: 1px dashed var(--pl-line); padding-top: 10px; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 32px; row-gap: 8px; z-index: 6; }
    .st-foot > .lg { grid-column: 1; }
    .st-foot .lg-cats .lg-list { --lg-max-h: 28px; }
    .st-mode { grid-column: 1; font: 12px/1.3 var(--pl-font-mono); color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-mode::before { content: '▸ '; color: var(--pl-accent); }
    .st-foot .mm-legend { position: static; grid-column: 2; grid-row: 1 / span 2; align-content: start; padding-top: 6px; }
    .mm-legend i.ghost { border-top: 2px dotted var(--pl-muted); }
    .mm-legend i.prop { border-top: 2px dashed var(--pl-accent); }
    /* a what-if's marks (as the board draws an open splice), and a slice's warning */
    .mm-card.st-card.mk-proposed { border: 1.5px dashed var(--pl-accent); background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--pl-accent) 11%, transparent) 0 5px, transparent 5px 11px); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pl-accent) 14%, transparent); }
    .mm-card.st-card.mk-removed .mm-name { text-decoration: line-through; text-decoration-thickness: 1.5px; }
    .st-badge.mk { font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; }
    .st-badge.mk.proposed { background: var(--pl-accent); color: var(--pl-card); }
    .st-badge.mk.removed { border: 1px dashed var(--pl-muted); color: var(--pl-muted); }
    .st-badge.mk.renamed, .st-badge.mk.moved { border: 1px solid var(--pl-accent); color: var(--pl-accent); }
    /* a warning (a conflict) has its own cue besides the colour, which a theme may share with "seen, not declared":
       a dotted ring on its cards, the ⚠ on its wires (a dotted line with a halo, drawn on the fx layer) */
    .mm-card.st-card.is-warn { outline: 2px dotted var(--pl-accent-2); outline-offset: 3px; }
    .st-mark.is-warn { width: 20px; height: 20px; margin: -10px 0 0 -10px; border: 1.5px solid var(--pl-accent-2); color: var(--pl-accent-2); font-size: 11px; cursor: pointer; }
    .st-mark.is-warn:hover, .st-mark.is-warn.is-on { background: var(--pl-accent-2); color: var(--pl-card); }
    .st-conf { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; min-width: 0; overflow: hidden; height: 20px; }
    .st-conf[hidden] { display: none; }
    .st-conf li { flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 6px; height: 20px; box-sizing: border-box; padding: 0 8px 0 3px; font: 11.5px/1 var(--pl-font-mono); color: var(--pl-fg); border: 1px dashed color-mix(in srgb, var(--pl-accent-2) 70%, transparent); border-radius: min(var(--pl-radius), 999px); cursor: pointer; white-space: nowrap; }
    .st-conf li .n { flex: none; display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; background: var(--pl-accent-2); color: var(--pl-card); font-weight: 700; font-size: 10px; }
    .st-conf li .t { overflow: hidden; text-overflow: ellipsis; }
    .st-conf li .who { flex: none; color: var(--pl-muted); }
    .st-conf li .k { flex: none; font-weight: 600; color: var(--pl-accent-2); }
    .st-conf li.t-note { border-color: var(--pl-line); }
    .st-conf li.t-note .n { background: var(--pl-muted); }
    .st-conf li.t-note .k { color: var(--pl-muted); }
    .st-conf li.t-note:hover, .st-conf li.t-note.is-on { border-color: var(--pl-fg); background: color-mix(in srgb, var(--pl-fg) 6%, var(--pl-card)); }
    .st-conf li.t-ask { border-color: color-mix(in srgb, var(--pl-accent) 70%, transparent); }
    .st-conf li.t-ask .n { background: var(--pl-accent); }
    .st-conf li.t-ask .k { color: var(--pl-accent); }
    .st-conf li.t-ask:hover, .st-conf li.t-ask.is-on { border-color: var(--pl-accent); background: color-mix(in srgb, var(--pl-accent) 10%, var(--pl-card)); }
    .st-now .st-quiet { color: var(--pl-muted); font-weight: 600; }
    .st-tab .w.is-note { color: var(--pl-muted); }
    .st-head-act { font: 700 12px/1 var(--pl-font-mono); padding: 3px 7px; margin-left: 6px; vertical-align: 1px; color: var(--pl-accent); background: var(--pl-card); border: 1px solid var(--pl-accent); border-radius: min(var(--pl-radius), 6px); cursor: pointer; }
    .st-head-act:hover, .st-head-act:focus-visible { background: var(--pl-accent); color: var(--pl-card); outline: none; }
    .st-conf li:hover, .st-conf li.is-on { border-style: solid; border-color: var(--pl-accent-2); background: color-mix(in srgb, var(--pl-accent-2) 10%, var(--pl-card)); }
    .st-conf li:focus-visible { outline: 2px solid var(--pl-accent-2); outline-offset: 2px; }
    .st-now .st-bdg, .st-tab .b, .st-about .st-bdg { flex: none; font: 700 9.5px/1 var(--pl-font-mono); letter-spacing: 0.07em; text-transform: uppercase; padding: 3px 5px; border-radius: 999px; border: 1px solid var(--pl-accent); color: var(--pl-accent); }
    .st-now .st-bdg { margin-left: 6px; vertical-align: 1px; }
    .st-now .st-alert, .st-tab .w { color: var(--pl-accent-2); font-weight: 600; }
    .st-tab .w { flex: none; }
    .st-tab .b { font-size: calc(9.5px * var(--st-k, 1)); }
    .st-btn.is-open { border-color: var(--pl-accent); color: var(--pl-accent); }
    .st-about { position: absolute; left: 0; top: 0; width: 420px; box-sizing: border-box; z-index: 8; padding: 10px 12px 11px; display: grid; gap: 6px; pointer-events: none; font: 12px/1.35 var(--pl-font-mono); }
    .st-about[hidden] { display: none; }
    .st-about .hd { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .st-about .hd b { font: 700 14px/1.2 var(--pl-font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .st-about .sub { color: var(--pl-muted); }
    .st-about ol { margin: 0; padding-left: 20px; display: grid; gap: 2px; }
    .st-about li.w { color: var(--pl-accent-2); list-style: none; margin-left: -20px; }
    .st-about .more, .st-about .hint { color: var(--pl-muted); }
    .st-about .hint { border-top: 1px dashed var(--pl-line); padding-top: 6px; }
    .st-wc { z-index: 9; }
    .st-wc[hidden] { display: none; }
    .mm-legend i.conf { border-top: 2.5px dotted var(--pl-accent-2); box-shadow: 0 0 0 2px color-mix(in srgb, var(--pl-accent-2) 16%, transparent); }
    ${LEGEND_CSS}
    ${WIRE_CSS}
  `;

  return class StackScene extends Scene implements StackApi {
    static title = o.title ?? `${N} ${nouns}`;
    static width = W;
    static height = H;
    static duration = DUR;
    static interactive = true;
    static fx = 'both' as const;

    private space!: Space3D;
    private morph = new Morph();
    private st: StackState = blank();
    private k = 1;
    private arc: { inc: number; out: number } | null = null;
    private sheets: HTMLElement[] = [];
    private cards: { el: HTMLElement; id: string }[][] = [];
    private legend!: LegendStrip;
    private legendFor = -1;
    /** The plate's geometry for the space it has (the page: the default; the theater: fitted to the window). */
    private g: Geo = GEO0;
    private fitMemo = new Map<string, Geo>();
    private geoMemo = new Map<string, Geo>([[GEO0.key, GEO0]]);
    private el!: { mode: HTMLElement; now: HTMLElement; prev: HTMLButtonElement; next: HTMLButtonElement; fan: HTMLButtonElement; open: HTMLButtonElement | null; about: HTMLElement; conf: HTMLElement | null; wc: HTMLElement };
    /** What the warning card and the header's list were built for, so they are rebuilt only when that changes. */
    private warnFor = '';
    private confFor = '';
    /** Where the hovered warning item was pointed at (stage px): its card sits beside it. Null: beside its first ⚠. */
    private warnAt: P | null = null;
    /** Where the pinned item was pointed at when it was pinned (its card stays there when the pointer moves on). */
    private pinAt: P | null = null;
    private warnTimer = 0;
    /** What the about card was built for (its slice, the current one), so it is rebuilt only when that changes. */
    private aboutFor = '';
    private nowFor = '';

    // ------------------------------------------------------------------ targets
    private entries(i = this.st.cur) { return this.spot ? [...entriesOf[i]!, this.spot] : entriesOf[i]!; }
    /** The ad-hoc entry `highlight()` pins (not drawn in the legend strip). */
    private spot: LegendEntry | null = null;
    private restPose(i: number): Vals {
      const d = i - this.st.cur, a = Math.abs(d), s = 1 - 0.008 * a;
      const { CY0, SH } = this.g;
      return { x: 0, y: CY0 + (SH / 2) * (1 - s) + PEEK * a, z: -(3 * a + (d > 0 ? 1.5 : 0)), rx: 0, s, front: d === 0 ? 1 : 0 };
    }
    private fanPose(i: number): Vals {
      return { x: 0, y: this.g.H / 2 - (this.g.b.fanTop + this.g.GAP * (i + 0.5)) + this.fanDY, z: 0, rx: FAN_RX, s: this.fanS, front: i === this.st.cur ? 1 : 0 };
    }
    private fanS = GEO0.FAN_S_MAX;
    private fanDY = 0;
    /** The overview's scale and vertical offset, measured rather than estimated (perspective makes the near
     *  edges of big sheets reach further than cos(tilt) says): the largest scale at which every sheet clears
     *  the one above it and the whole stack, tabs included, stays between the header and the legend. */
    private fitFan() {
      const sh = this.sheets;
      const measure = () => {
        for (let i = 0; i < N; i++) { const v = this.fanPose(i); this.space.pose(sh[i]!, { x: v.x, y: v.y, z: v.z, rx: v.rx, scale: v.s }); }
        Object.assign(this.space.cam, FAN_CAM);
        this.space.render();
        const top = sh.map((el) => Math.min(this.space.at(el, 0, 0).y, this.space.at(el, 1, 0).y) - TAB);
        const bot = sh.map((el) => Math.max(this.space.at(el, 0, 1).y, this.space.at(el, 1, 1).y));
        return { top, bot };
      };
      const { FAN_S_MAX, FAN_BOT } = this.g, TAB = this.g.b.tab, FAN_TOP = this.g.b.fanTop;
      for (this.fanS = FAN_S_MAX; this.fanS > 0.2; this.fanS *= 0.95) {
        this.fanDY = 0;
        const { top, bot } = measure();
        this.fanDY = ((top[0]! + bot[N - 1]!) / 2 - (FAN_TOP - TAB + FAN_BOT) / 2);   // centre the stack (world y is up)
        // a sheet's own edge clears the one above (its flat tab may sit over the empty foot of that sheet)
        const clear = bot.every((b, i) => i === N - 1 || b <= top[i + 1]! + TAB - 2);
        if (clear && bot[N - 1]! - top[0]! <= FAN_BOT - FAN_TOP + TAB) break;
      }
    }
    private targets(): Map<string, Vals> {
      const m = new Map<string, Vals>();
      for (let i = 0; i < N; i++) m.set(`s:${i}`, this.st.fan ? this.fanPose(i) : this.restPose(i));
      m.set('f', { f: this.st.fan ? 1 : 0 });
      m.set('cam', this.st.fan ? FAN_CAM : { yaw: 0, pitch: 0 });
      const pinned = pinnedMembers(this.entries(), this.st.pins);
      for (const id of allNodes.keys()) m.set(`d:${id}`, { d: pinned ? (pinned.has(id) ? 1 : DIM_PIN) : 1 });
      return m;
    }
    /** The slide's arc: the incoming sheet lifts toward the viewer and settles, the outgoing one sinks back. */
    private arcTerm(i: number, k: number) {
      if (!this.arc) return { z: 0, rx: 0 };
      const b = Math.sin(Math.PI * clamp(k));
      if (i === this.arc.inc) return { z: 36 * b, rx: -5 * b };
      if (i === this.arc.out) return { z: -60 * b, rx: 0 };
      return { z: 0, rx: 0 };
    }
    /** Change of meaning: glide from what is on screen (arc included, so an interrupted slide never jumps) to the new rest. */
    private change(next: Partial<StackState>) {
      const now = new Map<string, Vals>();
      for (const key of this.targets().keys()) {
        const v = this.morph.value(key);
        if (!v) continue;
        if (key.startsWith('s:')) { const a = this.arcTerm(+key.slice(2), this.k); now.set(key, { ...v, z: v.z! + a.z, rx: v.rx! + a.rx }); }
        else now.set(key, v);
      }
      this.morph.snap(now);
      const was = this.st.cur;
      this.st = { ...this.st, ...next };
      // a warning's card belongs to its slice
      if (this.st.cur !== was) { this.st.warn = null; this.st.warnPin = null; }
      this.arc = this.st.cur !== was ? { inc: this.st.cur, out: was } : null;
      this.morph.retarget(this.targets());
      this.k = 0;
      this.stage.transition();
    }
    private snapAll() { this.arc = null; this.morph.snap(this.targets()); this.k = 1; }

    // ------------------------------------------------------------------ API
    go(i: number) {
      const j = clamp(Math.round(i), 0, N - 1);
      if (j === this.st.cur) return;
      this.change({ cur: j });
    }
    next() { this.go(this.st.cur + 1); }
    prev() { this.go(this.st.cur - 1); }
    fan(on = !this.st.fan) { if (on !== this.st.fan) this.change({ fan: on }); }
    /** Open slice i flat (a tab, a sheet): slide to it and close the overview in one move. */
    private open(i: number) { if (i !== this.st.cur || this.st.fan) this.change({ cur: i, fan: false }); }
    focusTag(tagId: string | null) {
      const id = tagId === null ? null : resolveEntry(this.entries(), tagId) ?? (this.entries().some((e) => e.id === `diff:${tagId}`) ? `diff:${tagId}` : null);
      if (tagId !== null && !id) return;
      const pins = id ? [id] : [];
      if (JSON.stringify(pins) === JSON.stringify(this.st.pins)) return;
      this.change({ pins });
    }
    highlight(nodeIds: string[] | null) {
      const ids = [...new Set((nodeIds ?? []).filter((id) => allNodes.has(id)))];
      const had = this.st.pins.includes(HIGHLIGHT);
      this.spot = ids.length ? highlightEntry(ids) : null;
      if (!ids.length && !had) return;
      this.change({ pins: ids.length ? [HIGHLIGHT] : this.st.pins.filter((p) => p !== HIGHLIGHT) });
    }
    describe(): PlateOutline {
      const v = views[this.st.cur]!;
      return {
        kind: 'stack', title: o.title ?? `${N} ${nouns}`,
        nodes: v.nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, group: bandOf(n), category: n.category ?? null, tags: [...(n.tags ?? [])], ...(nodeMark(this.st.cur, n.id) ? { mark: nodeMark(this.st.cur, n.id)! } : {}) })),
        groups: L.groups.map((g) => ({ id: g.id, label: g.id === '·outside' ? 'outside' : g.id })),
        tags: outlineTags(this.entries()),
        steps: slices.map((s) => s.title),
      };
    }
    private togglePin(id: string) {
      if (!this.entries().some((e) => e.id === id)) return;
      this.change({ pins: this.st.pins.includes(id) ? this.st.pins.filter((p) => p !== id) : [...this.st.pins, id] });
    }
    private setTab(i: number | null) {
      if (i === (this.st.tab ?? null)) return;
      this.st.tab = i;
      this.stage.redraw();
    }
    /** The current slice's warning item whose card shows (lit, explained): the hovered one, else the pinned one. */
    private shownWarn(): number | null { const k = this.st.warn ?? this.st.warnPin ?? null; return k !== null && itemsOf[this.st.cur]![k] ? k : null; }
    /** The legend entry lit now: the hovered one, else the shown warning item's. */
    private activeHover(): string | null { if (this.st.hover) return this.st.hover; const k = this.shownWarn(); return k === null ? null : `warn:${k + 1}`; }
    private setWarn(k: number | null, at: P | null = null) {
      clearTimeout(this.warnTimer);
      if (k === (this.st.warn ?? null)) return;
      this.st.warn = k; this.warnAt = k === null ? null : at;
      this.stage.redraw();
    }
    /** Leave a warning's hover after a moment, so the pointer can cross over to its card (and its buttons). */
    private leaveWarn() { clearTimeout(this.warnTimer); this.warnTimer = window.setTimeout(() => this.setWarn(null), 260); }
    private pinWarn(k: number | null, at: P | null = null) {
      const p = k !== null && this.st.warnPin === k ? null : k;
      if (p === (this.st.warnPin ?? null)) return;
      this.st.warnPin = p; this.pinAt = p === null ? null : at ?? (this.st.warn === p ? this.warnAt : null);
      this.stage.redraw();
    }
    showWarning(k: number | null): boolean {
      if (k !== null && !itemsOf[this.st.cur]![k]) return false;
      clearTimeout(this.warnTimer);
      this.st.warn = null; this.warnAt = null; this.st.warnPin = k; this.pinAt = null;
      this.stage.redraw();
      return true;
    }
    /** Client (pointer) coordinates → stage px, and stage px per screen px, measured on the plate itself: a host may
     *  scale the plate again (the board's stack sits inside the board's own scaled plate). */
    private toStage(cx: number, cy: number) {
      const r = this.stage.dom.getBoundingClientRect(), k = r.width / this.stage.W || 1;
      return { x: (cx - r.left) / k, y: (cy - r.top) / k, k };
    }
    /** A sheet-local point on slice i, in stage px (the sheet's projection this frame). */
    private proj(i: number, p: P) { return this.space.at(this.sheets[i]!, p.x / this.g.SW, p.y / this.g.SH); }
    /** A card of slice i, in stage px. */
    private cardBox(i: number, id: string) {
      const q = this.g.pos.get(id);
      if (!q) return null;
      const sz = boxOf(L, id);   // a kit kind's card has its own size
      const a = this.proj(i, { x: q.x - MX, y: q.y - SY0 }), b = this.proj(i, { x: q.x - MX + sz.w, y: q.y - SY0 + sz.h });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    /** The warning item a pointer is on: a ⚠ on a wire, a warned card or wire of the current slice, an item of the list. */
    private warnUnder(e: MouseEvent): { k: number; at: P | null } | null {
      const t = e.target as HTMLElement | null, i = this.st.cur;
      if (!t || this.st.fan) return null;
      const { k: zoom, ...at } = this.toStage(e.clientX, e.clientY);
      const li = t.closest<HTMLElement>('.st-conf li');
      if (li) { const r = li.getBoundingClientRect(), { x, y } = this.toStage(r.left, r.bottom); return { k: +li.dataset.warn!, at: { x, y } }; }
      if (!t.closest(`#st-sheet-${i}`)) return null;
      const m = t.closest<HTMLElement>('.st-mark.is-warn');
      if (m) { const k = m.dataset.warn?.split(' ').filter(Boolean).map(Number)[0]; return k === undefined ? null : { k, at }; }
      const c = t.closest<HTMLElement>('.st-card');
      if (c) { const k = itemsByNode[i]!.get(c.dataset.node!)?.[0]; return k === undefined ? null : { k, at }; }
      if (t.closest('button, .mm-group > .pl-label')) return null;
      // a warned wire under the pointer
      const paths = [...itemsByPair[i]!.keys()].filter((key) => pairOf.has(key)).map((key) => [key, new Path(localPath(this.g, pairOf.get(key)!).pts.map((q) => this.proj(i, q)))] as const);
      const key = paths.length ? pickPath(paths, at, Math.max(4, 6 / zoom)) : null;
      return key ? { k: itemsByPair[i]!.get(key)![0]!, at } : null;
    }
    /** Where a warning item's card goes: beside where it was pointed at, else beside its first ⚠ (or card); off its cards. */
    private warnAnchor(k: number): { at: P; avoid: { x: number; y: number; w: number; h: number }[] } {
      const i = this.st.cur, it = itemsOf[i]![k]!;
      const ends = [...(it.nodes ?? []), ...(it.pairs ?? []).flatMap((key) => { const p = pairOf.get(key); return p ? [p.from, p.to] : []; })];
      const avoid = [...new Set(ends)].map((id) => this.cardBox(i, id)).filter((b): b is NonNullable<typeof b> => !!b);
      if (this.st.warn === k && this.warnAt) return { at: this.warnAt, avoid };
      if (this.st.warnPin === k && this.pinAt) return { at: this.pinAt, avoid };
      const key = (it.pairs ?? []).find((x) => pairOf.has(x));
      if (key) return { at: this.proj(i, localPath(this.g, pairOf.get(key)!).at(markAt[i]!.get(key) ?? 0.5)), avoid };
      const b = avoid[0];
      return { at: b ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: this.g.W / 2, y: this.g.H / 2 }, avoid };
    }
    private setHover(id: string | null) {
      if (id === (this.st.hover ?? null)) return;
      this.st.hover = id;
      this.stage.redraw();
    }

    // ------------------------------------------------------------------ geometry
    /** Write the current geometry into the DOM: sheet sizes, where cards, group frames and change glyphs sit, tab widths. */
    private place() {
      const g = this.g;
      this.sheets.forEach((sheet) => {
        Object.assign(sheet.style, { width: `${g.SW}px`, height: `${g.SH}px` });
        for (const c of sheet.querySelectorAll<HTMLElement>('.st-card')) { const p = g.pos.get(c.dataset.node!)!; Object.assign(c.style, { left: `${p.x - MX}px`, top: `${p.y - SY0}px` }); }
        for (const b of sheet.querySelectorAll<HTMLElement>('.mm-group')) {
          const r = g.groups.get(b.dataset.g!)!;
          Object.assign(b.style, { left: `${r.x - MX}px`, top: `${r.y - SY0}px`, width: `${r.w}px`, height: `${r.h}px` });
        }
        for (const m of sheet.querySelectorAll<HTMLElement>('.st-mark')) { const p = localPath(g, pairOf.get(m.dataset.key!)!).at(+m.dataset.u!); Object.assign(m.style, { left: `${p.x}px`, top: `${p.y}px` }); }
      });
      for (const t of this.stage.dom.querySelectorAll<HTMLElement>('.st-tab')) t.style.width = `${g.TW}px`;
      // the tabs ride the sheets (placed in stage px): drawn here as large as the chrome floor draws chrome, so the floor
      // leaves them where they are (data-pl-floor="own")
      if (g.b.k === 1) this.stage.dom.style.removeProperty('--st-k'); else this.stage.dom.style.setProperty('--st-k', String(g.b.k));
    }
    /** Theater relayout (docs/ENGINE.md "Theater"): the group bands arranged for the window's aspect (arrange.ts, over the
     *  union of every slice's nodes, so a node still sits at one place on every slice); null = the page's default. The
     *  sheets, tabs and overview follow; the foot is docked to the bottom. Snaps: the window changed, not the meaning. */
    fit(space: { w: number; h: number } | null, o?: { chrome?: number }) {
      const ck = Math.max(1, Math.round((o?.chrome ?? 1) * 100) / 100), b = ck === 1 ? B1 : bandsAt(ck);
      const k = `${space ? `${Math.round(space.w)}x${Math.round(space.h)}` : 'page'}@${ck}`;
      let g = this.fitMemo.get(k);
      if (!g) {
        const r = space ? arrange(L, space, arrangeOpts(b)) : ck === 1 ? DEFAULT : arrange(L, null, arrangeOpts(b)), gk = `${r.a.key}@${r.W}x${r.H}@${ck}`;
        g = this.geoMemo.get(gk) ?? this.geoMemo.set(gk, geoOf(r, b)).get(gk)!;
        this.fitMemo.set(k, g);
      }
      if (g !== this.g) {
        this.g = g;
        this.place();
        this.space.resize(g.W, g.H);
        this.fitFan();
        this.snapAll();
        if (g.W === this.stage.W && g.H === this.stage.H) this.stage.redraw();
      }
      return { w: g.W, h: g.H };
    }

    // ------------------------------------------------------------------ build
    build(dom: HTMLElement) {
      dom.innerHTML = `<style>${MAP_CSS}${CSS}${kits?.css() ?? ''}</style>
        <header class="st-head" data-pl-chrome><div class="pl-label">${esc(o.summary ?? `${N} ${nouns}`)}</div><h1 class="pl-title">${esc(o.title ?? `${N} ${nouns}`)}</h1><div class="st-now" aria-live="polite"></div>${HEAD_H > HEAD_H0 ? '<ol class="st-conf" hidden></ol>' : ''}</header>
        <div class="st-toolbar" data-pl-chrome>
          ${o.open ? '<button type="button" class="st-btn is-open" data-open></button>' : ''}
          <button type="button" class="st-btn" data-prev title="Previous ${noun} (← or k)" aria-label="Previous ${noun}">‹</button>
          <button type="button" class="st-btn" data-next title="Next ${noun} (→ or j)" aria-label="Next ${noun}">›</button>
          <button type="button" class="st-btn" data-fan aria-pressed="false" title="See every ${noun} at once (o; Esc to collapse)">Fan out</button>
          ${(o.buttons ?? []).map((b, i) => `<button type="button" class="st-btn" data-btn="${i}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.label)}</button>`).join('')}
        </div>
        ${views.map((v, i) => sheetHTML(v, i)).join('')}
        ${views.map((v, i) => { const c = counts(v); const d = NODIFF ? '' : v.diff.first ? 'first' : [c.add && `+${c.add}`, c.rem && `−${c.rem}`, c.chg && `~${c.chg}`].filter(Boolean).join(' ') || 'same';
          return `<button type="button" class="st-tab" data-pl-chrome data-pl-floor="own" id="st-tab-${i}" data-tab="${i}" title="${esc(`${noun} ${i + 1}: ${v.slice.title}${v.slice.subtitle ? ` · ${v.slice.subtitle}` : ''}${NODIFF ? '' : ` · ${v.diff.first ? 'the first' : `vs ${noun} ${i}: ${c.add} added, ${c.rem} removed, ${c.chg} changed`}`}`)}"><span class="n">${i + 1}</span><span class="t">${esc(v.slice.title)}</span>${v.slice.badge ? `<span class="b">${esc(v.slice.badge)}</span>` : ''}${v.slice.warning ? `<span class="w${v.slice.warning.tone === 'note' ? ' is-note' : ''}" aria-label="${esc(v.slice.warning.text)}">${v.slice.warning.tone === 'note' ? esc(v.slice.warning.items?.[0]?.sym ?? '·') : '⚠'}</span>` : ''}${d ? `<span class="d">${d}</span>` : ''}</button>`; }).join('')}
        <div class="pl-card st-about" data-pl-chrome="bare" hidden></div>
        <div class="pl-card wh-card is-warncard st-wc" role="dialog" hidden></div>
        <div class="st-foot" data-pl-chrome>
          <div class="st-mode" aria-live="polite"></div>
          <div class="mm-legend"><span><i></i>declared and seen</span><span><i class="dash"></i>declared, not seen</span><span><i class="warn"></i>seen, not declared</span>${NODIFF
            // the marks' key is the legend's (hover an entry to light it); here, only what a line's look means
            ? `${views.some((v) => v.slice.marks) ? '<span><i class="prop"></i>proposed</span><span><i class="ghost"></i>removed (ghost)</span>' : ''}${views.some((v) => v.slice.warning?.pairs?.length) ? `<span><i class="conf"></i>⚠ ${esc(views.find((v) => v.slice.warning?.pairs?.length)!.slice.warning!.name ?? 'warning')}</span>` : ''}`
            : `<span><i class="ghost"></i>removed here</span>${views.some((v) => v.slice.marks) ? '<span><i class="prop"></i>proposed</span>' : ''}`}</div>
        </div>`;
      const q = <T extends HTMLElement>(s: string) => dom.querySelector<T>(s)!;
      this.el = { mode: q('.st-mode'), now: q('.st-now'), prev: q<HTMLButtonElement>('[data-prev]'), next: q<HTMLButtonElement>('[data-next]'), fan: q<HTMLButtonElement>('[data-fan]'), open: dom.querySelector<HTMLButtonElement>('[data-open]'), about: q('.st-about'), conf: dom.querySelector('.st-conf'), wc: q('.st-wc') };
      // a warning's numbered items (a ⚠ on a wire, its wires and cards, the header's list): a card on hover, pinned by a click
      dom.addEventListener('pointermove', (e) => {
        if ((e.target as HTMLElement).closest('.st-wc')) { clearTimeout(this.warnTimer); return; }
        const w = this.warnUnder(e);
        if (w) { clearTimeout(this.warnTimer); if (w.k !== this.st.warn) this.setWarn(w.k, w.at); }
        else if (this.st.warn != null) this.leaveWarn();
      });
      dom.addEventListener('pointerleave', () => { if (this.st.warn != null) this.leaveWarn(); });
      // capture: before a sheet's own click (which opens its slice)
      dom.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const ob = t.closest<HTMLElement>('[data-open-slice]');
        if (ob) { e.stopPropagation(); o.open?.run(+ob.dataset.openSlice!); return; }
        const ia = t.closest<HTMLElement>('[data-item-act]');
        if (ia) { e.stopPropagation(); const k = this.shownWarn(); if (k !== null) o.itemAction?.(this.st.cur, k, ia.dataset.itemAct!); return; }
        const ha = t.closest<HTMLElement>('[data-head-act]');
        if (ha) { e.stopPropagation(); o.headAction?.(this.st.cur)?.run(); return; }
        if (t.closest('.st-wc')) { e.stopPropagation(); return; }
        const w = this.warnUnder(e);
        if (w) { e.stopPropagation(); this.pinWarn(w.k, w.at); return; }
        if (this.st.warnPin != null && !t.closest('button, .lg')) { e.stopPropagation(); this.pinWarn(null); }
      }, true);
      dom.addEventListener('focusin', (e) => {
        const li = (e.target as HTMLElement).closest<HTMLElement>('.st-conf li');
        if (li) { const r = li.getBoundingClientRect(), { x, y } = this.toStage(r.left, r.bottom); this.setWarn(+li.dataset.warn!, { x, y }); }
      });
      dom.addEventListener('focusout', (e) => { if ((e.target as HTMLElement).closest('.st-conf li') && this.st.warn != null) this.setWarn(null); });
      const foot = q('.st-foot');
      this.legend = new LegendStrip(foot, { onHover: (id) => this.setHover(id), onToggle: (id) => this.togglePin(id), keyHints: false, titles: { tags: 'Changes' } });
      foot.prepend(this.legend.el);

      this.sheets = views.map((_, i) => q(`#st-sheet-${i}`));
      this.place();
      this.space = new Space3D(this.stage, { fov: 30 });
      this.sheets.forEach((el, i) => {
        this.space.add(el, { y: GEO0.CY0 });
        // a back sheet (or any, fanned out) comes forward; the current one opens where the host says (o.open)
        el.addEventListener('click', () => { if (i !== this.st.cur || this.st.fan) this.open(i); else o.open?.run(i); });
      });
      this.cards = this.sheets.map((el) => [...el.querySelectorAll<HTMLElement>('.st-card')].map((c) => ({ el: c, id: c.dataset.node! })));
      dom.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-prev],[data-next],[data-fan],[data-open],[data-btn]');
        if (!t) return;
        if (t.dataset.btn !== undefined) o.buttons?.[+t.dataset.btn]?.run();
        else if (t.dataset.open !== undefined) o.open?.run(this.st.cur);
        else if (t.dataset.tab !== undefined) this.open(+t.dataset.tab);
        else if (t.dataset.prev !== undefined) this.prev();
        else if (t.dataset.next !== undefined) this.next();
        else this.fan();
      });
      // a tab under the pointer (or focused) says what its slice is: state at rest, like the legend's hover
      for (const t of dom.querySelectorAll<HTMLElement>('.st-tab')) {
        const i = +t.dataset.tab!;
        t.addEventListener('pointerenter', () => this.setTab(i));
        t.addEventListener('pointerleave', () => { if (this.st.tab === i) this.setTab(null); });
        t.addEventListener('focus', () => this.setTab(i));
        t.addEventListener('blur', () => { if (this.st.tab === i) this.setTab(null); });
      }
      this.fitFan();
      this.snapAll();
    }

    // ------------------------------------------------------------------ state
    getState(): StackState { return { ...this.st, pins: [...this.st.pins], warn: this.st.warn ?? null, warnPin: this.st.warnPin ?? null }; }
    setState(raw: unknown) {
      const s = { ...blank(), ...(raw && typeof raw === 'object' ? raw as Partial<StackState> : {}) };
      // as if navigated from the rest state (the last slice, or `o.rest`, flat): start there, then transition into s
      this.st = blank();
      this.snapAll();
      const cur = clamp(Math.round(Number(s.cur) || 0), 0, N - 1);
      const ents = entriesOf[cur]!;
      const pick = (id: unknown) => (typeof id === 'string' ? resolveEntry(ents, id) : null);
      const tab = typeof s.tab === 'number' && s.tab >= 0 && s.tab < N ? Math.round(s.tab) : null;
      const item = (k: unknown) => (typeof k === 'number' && itemsOf[cur]![Math.round(k)] ? Math.round(k) : null);
      this.st = { cur, fan: !!s.fan, pins: (Array.isArray(s.pins) ? s.pins : []).map(pick).filter((p): p is string => !!p), hover: pick(s.hover), tab, warn: item(s.warn), warnPin: item(s.warnPin) };
      this.warnAt = null;
      this.arc = cur !== REST ? { inc: cur, out: REST } : null;
      this.morph.retarget(this.targets());
      this.k = 0;
    }
    states() {
      const last = N - 1;
      const out: { name: string; state: StackState }[] = [
        { name: 'slice-1', state: { ...blank(), cur: 0 } },
        { name: 'slice-last', state: { ...blank(), cur: last } },
        { name: 'fanned', state: { ...blank(), fan: true } },
      ];
      // a pinned diff entry, only when the last slice has that kind of change (an empty pin dims everything)
      for (const k of ['added', 'removed', 'changed'] as const) {
        if (entriesOf[last]!.find((e) => e.id === `diff:${k}`)?.members.length) out.push({ name: `diff-pin-${k}`, state: { ...blank(), cur: last, pins: [`diff:${k}`] } });
      }
      if (entriesOf[last]!.find((e) => e.id === 'diff:changed')?.members.length) out.push({ name: 'diff-hover-changed', state: { ...blank(), cur: last, hover: 'diff:changed' } });
      // a warning item's card, pinned (the first slice that has them)
      const wi = itemsOf.findIndex((x) => x.length);
      if (wi >= 0) out.push({ name: 'warning-card', state: { ...blank(), cur: wi, warnPin: 0 } });
      return out;
    }

    // ------------------------------------------------------------------ keys
    /** Key help (docs/ENGINE.md "Key help"): what `onKey` does right now. */
    keys(): KeyHelp[] {
      const G = nouns[0]!.toUpperCase() + nouns.slice(1), i = this.st.cur, last = i === N - 1, first = i === 0;
      const out: KeyHelp[] = [
        { group: G, keys: ['→', 'j'], does: `next ${noun}`, ...(last ? { off: true, when: `before the last ${noun}` } : {}) },
        { group: G, keys: ['←', 'k'], does: `previous ${noun}`, ...(first ? { off: true, when: `after the first ${noun}` } : {}) },
        { group: G, keys: 'Home', does: `the first ${noun}`, ...(first ? { off: true, when: `after the first ${noun}` } : {}) },
        { group: G, keys: 'End', does: `the last ${noun}`, ...(last ? { off: true, when: `before the last ${noun}` } : {}) },
      ];
      const n = Math.min(9, N);
      if (n > 1) out.push({ group: G, keys: `1–${n}`, does: `go to ${noun} 1–${n}` });
      out.push({ group: G, keys: 'o', does: this.st.fan ? 'collapse the overview' : `fan out: every ${noun} in 3D` });
      if (this.st.fan) out.push({ group: G, keys: 'Enter', does: `open ${noun} ${i + 1} flat` });
      else if (o.open) out.push({ group: G, keys: 'Enter', does: o.open.label(i) });
      const esc = this.st.warnPin != null || this.st.warn != null ? `close the ${views[i]!.slice.warning?.name ?? 'warning'} card` : this.st.fan ? 'collapse the overview' : this.st.pins.length ? 'clear the pinned legend entries' : null;
      if (esc) out.push({ group: G, keys: 'Esc', does: esc });
      return out;
    }
    onKey(e: KeyboardEvent) {
      const tg = e.target as HTMLElement;
      if (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA') return false;
      if (tg.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return false;
      const li = tg.closest?.<HTMLElement>('.st-conf li');
      if (li && (e.key === 'Enter' || e.key === ' ')) { this.pinWarn(+li.dataset.warn!); return true; }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key;
      if (k === 'ArrowRight' || k === 'j') { this.next(); return true; }
      if (k === 'ArrowLeft' || k === 'k') { this.prev(); return true; }
      if (k === 'Home') { this.go(0); return true; }
      if (k === 'End') { this.go(N - 1); return true; }
      if (/^[1-9]$/.test(k)) { if (+k <= N) this.go(+k - 1); return true; }
      if (k === 'o') { this.fan(); return true; }
      if (k === 'Enter' && this.st.fan) { this.fan(false); return true; }
      if (k === 'Enter' && o.open) { o.open.run(this.st.cur); return true; }
      if (k === 'Escape') {
        if (this.st.warnPin != null || this.st.warn != null) { clearTimeout(this.warnTimer); this.st.warn = null; this.st.warnPin = null; this.stage.redraw(); return true; }
        if (this.st.fan) { this.fan(false); return true; }
        if (this.st.pins.length) { this.change({ pins: [] }); return true; }
        return false;
      }
      return false;
    }

    // ------------------------------------------------------------------ frame
    private entry(id: string | null | undefined) { return id ? this.entries().find((e) => e.id === id) : undefined; }
    private modeText() {
      const i = this.st.cur, hv = this.entry(this.st.hover);
      if (hv) { const d = this.details(hv.id); return `lighting “${hv.name}” (${hv.members.length})${d ? `: ${d}` : ''} — click to ${this.st.pins.includes(hv.id) ? 'unpin' : 'pin'} it`; }
      const tb = this.st.tab ?? null;
      if (tb !== null && views[tb]) {
        const sl = views[tb]!.slice, ab = sl.about ?? [];
        return `${noun} ${tb + 1}: ${sl.title}${sl.badge ? ` (${sl.badge})` : ''}${ab.length ? ` — ${ab[0]}${ab.length > 1 ? ` · +${ab.length - 1} more` : ''}` : ''}${sl.warning ? ` · ${sl.warning.text}` : ''}`;
      }
      if (this.st.fan) return `overview: all ${N} ${nouns}, first at the top · ←/→ pick · click one or Enter to open it · o or Esc collapses`;
      const wk = this.shownWarn(), its = itemsOf[i]!, wn = views[i]!.slice.warning?.name ?? 'warning';
      if (wk !== null) {
        const it = its[wk]!;
        return `${it.sym ?? '⚠'} ${it.name ?? wn} ${wk + 1} of ${its.length}: ${it.title}${it.who?.length ? ` — ${it.who.join(' and ')}` : ''} · ${this.st.warnPin === wk ? 'pinned · Esc closes' : 'click to pin its card'}`;
      }
      if (this.st.pins.length) {
        const es = this.st.pins.map((p) => this.entry(p)).filter((x): x is LegendEntry => !!x), n = pinnedMembers(this.entries(), this.st.pins)?.size ?? 0;
        const d = es.length === 1 ? this.details(es[0]!.id) : '';
        return `pinned: ${es.map((x) => x.name).join(' + ')} (${n})${d ? `: ${d}` : ''} — click again to unpin · Esc clears`;
      }
      const mixed = its.some((it) => it.name && it.name !== wn) || its.some((it) => it.tone === 'note');
      const hint = its.length ? (mixed ? 'hover an item in the header to see what it is · ' : `hover a ⚠ to see what each ${wn} is · `) : '';
      if (o.open) return `${noun} ${i + 1} of ${N} · ${hint}←/→ slide · hover a tab for what it holds · click the ${noun} or Enter: ${o.open.label(i).toLowerCase()} · o fan out`;
      if (hint) return `${noun} ${i + 1} of ${N} · ${hint}←/→ slide · o fan out · f theater`;
      return `${noun} ${i + 1} of ${N} · ←/→ slide · o fan out · hover the legend to light what changed · f theater`;
    }
    /** A mark entry's cards and wires on the current slice, by name. */
    private markItems(id: string, w: (e: { from: string; to: string }) => string) {
      const i = this.st.cur, e = this.entry(id), keys = diffKeys[i]!.get(id) ?? new Set<string>();
      const marked = (e?.members ?? []).filter((n) => nodeMark(i, n));
      return [...marked.map(label), ...[...keys].map((k) => pairOf.get(k)).filter((p): p is Pick<Wire, 'key' | 'from' | 'to'> => !!p).map(w)];
    }
    /** What a diff entry stands for on the current slice, in words (the mode line). */
    private details(id: string) {
      const d = views[this.st.cur]!.diff, w = (e: { from: string; to: string }) => `${label(e.from)} → ${label(e.to)}`;
      const items = id === 'diff:added' ? [...d.addedNodes.map(label), ...d.addedPairs.map(w)]
        : id === 'diff:removed' ? [...d.removedNodes.map(label), ...d.removedPairs.map(w)]
          : id === 'diff:changed' ? [...d.changedNodes.map((c) => `${label(c.id)} (${c.what.join('; ')})`), ...d.changedPairs.map((c) => `${w(c)} (${c.what.join('; ')})`)]
            : id === 'slice:warning' ? [...(views[this.st.cur]!.slice.warning?.details ?? [])]
              : id.startsWith('splice:') ? this.markItems(id, w) : [];
      return items.slice(0, 3).join(' · ') + (items.length > 3 ? ` · +${items.length - 3} more` : '');
    }
    private syncChrome() {
      if (this.legendFor !== this.st.cur) {
        // counts differ per slice: re-render, keeping keyboard focus on the same entry (or the plate)
        const had = this.legend.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.lg ?? '' : null;
        const es = this.entries().filter((e) => e.id !== HIGHLIGHT && !e.id.startsWith('warn:'));
        this.legend.render(es.filter((e) => e.kind === 'category'), es.filter((e) => e.kind !== 'category'));
        this.legendFor = this.st.cur;
        if (had !== null) ([...this.legend.el.querySelectorAll<HTMLElement>('[data-lg]')].find((b) => b.dataset.lg === had) ?? this.stage.viewport).focus({ preventScroll: true });
      }
      this.legend.sync({ pins: this.st.pins, hover: this.st.hover ?? null, picked: 0, editable: false });
      const mt = this.modeText();
      if (this.el.mode.textContent !== mt) this.el.mode.textContent = mt;
      const v = views[this.st.cur]!, c = counts(v);
      // what the slice changes: against its neighbour, or (no neighbour diff) what its own marks say, by the key's names
      const vs = NODIFF ? markEntries[this.st.cur]!.entries.filter((e) => e.sample && !e.id.startsWith('slice:warning')).map((e) => `${e.count ?? e.members.length} ${e.name}`).join(', ')
        : v.diff.first ? `the first ${noun}` : `vs ${noun} ${this.st.cur}: ${[c.add && `${c.add} added`, c.rem && `${c.rem} removed`, c.chg && `${c.chg} changed`].filter(Boolean).join(', ') || 'no changes'}`;
      const sl = v.slice, its = itemsOf[this.st.cur]!;
      const ha = o.headAction?.(this.st.cur) ?? null;
      const now = `<b>${esc(sl.title)}</b>${ha ? ` <button type="button" class="st-head-act" data-head-act title="${esc(ha.title)}" aria-label="${esc(ha.title)}">${esc(ha.label)}</button>` : ''}${sl.badge ? `<span class="st-bdg">${esc(sl.badge)}</span>` : ''}${sl.warning ? ` · <span class="${sl.warning.tone === 'note' ? 'st-quiet' : 'st-alert'}">${esc(sl.warning.text)}</span>` : ''}${sl.subtitle ? ` · ${esc(sl.subtitle)}` : ''}${vs ? ` · ${vs}` : ''}`;
      if (this.nowFor !== now) { this.el.now.innerHTML = now; this.nowFor = now; this.el.now.title = sl.warning && !its.length ? [sl.warning.text, ...(sl.warning.details ?? [])].join('\n') : ''; }
      // the warning's numbered items, one line under it: what each concerns and who is involved
      const cf = this.el.conf;
      if (cf) {
        if (this.confFor !== String(this.st.cur)) {
          const wn = sl.warning?.name ?? 'warning';
          cf.innerHTML = its.map((it, k) => `<li data-warn="${k}" class="t-${it.tone ?? 'warn'}" tabindex="0" role="button" aria-label="${esc(`${it.name ?? wn} ${k + 1}: ${it.title}${it.who?.length ? `, ${it.who.join(' and ')}` : ''}`)}"><span class="n">${k + 1}</span>${it.name ? `<span class="k">${esc(`${it.sym ?? ''} ${it.name}`.trim())}</span>` : ''}<span class="t">${esc(it.title)}</span>${it.who?.length ? `<span class="who">${esc(it.who.join(' · '))}</span>` : ''}</li>`).join('');
          cf.hidden = !its.length;
          this.confFor = String(this.st.cur);
        }
        const wk = this.shownWarn();
        for (const li of cf.children) li.classList.toggle('is-on', +(li as HTMLElement).dataset.warn! === wk);
      }
      if (this.el.open) {
        const t = o.open!.label(this.st.cur), h = o.open!.hint?.(this.st.cur) ?? t;
        if (this.el.open.textContent !== t) { this.el.open.textContent = t; this.el.open.title = `${h} (Enter)`; }
      }
      if (this.el.prev.disabled !== (this.st.cur === 0)) this.el.prev.disabled = this.st.cur === 0;
      if (this.el.next.disabled !== (this.st.cur === N - 1)) this.el.next.disabled = this.st.cur === N - 1;
      const fp = String(this.st.fan);
      if (this.el.fan.getAttribute('aria-pressed') !== fp) { this.el.fan.setAttribute('aria-pressed', fp); this.el.fan.textContent = this.st.fan ? 'Collapse' : 'Fan out'; }
    }
    /** What is lit: node ids, and the wires lit by a diff entry (else a wire is lit when both its ends are). */
    private lit() {
      const hv = this.activeHover();
      const active = hv && this.entry(hv) ? [hv] : this.st.pins.filter((p) => this.entry(p));
      if (!active.length) return null;
      const nodes = new Set<string>(), keys = new Set<string>(), ends = new Set<string>();
      for (const id of active) {
        const e = this.entry(id)!;
        e.members.forEach((m) => nodes.add(m));
        const dk = diffKeys[this.st.cur]!.get(id);
        if (dk) dk.forEach((k) => keys.add(k)); else e.members.forEach((m) => ends.add(m));
      }
      return { nodes, keys, ends };
    }

    update(f: Frame) {
      const k = ease.inOutCubic(clamp(f.t / f.duration));
      this.k = k;
      this.morph.progress(k);
      this.syncChrome();
      const F = this.morph.value('f')!.f!;
      const cam = this.morph.value('cam')!;
      this.space.cam.yaw = cam.yaw!; this.space.cam.pitch = cam.pitch!;
      const hv = this.activeHover();
      const hoverLit = hv ? litMembers(this.entries(), [], hv) : null;
      const lit = this.lit();
      this.sheets.forEach((el, i) => {
        const v = this.morph.value(`s:${i}`)!, a = this.arcTerm(i, k);
        // at rest the current sheet is plain DOM, not a 3D layer: its text is crisp (Space3D honours `flat` only face-on,
        // where it lands exactly on the 3D pose); it goes back into 3D for the length of a slide or the overview
        this.space.pose(el, { x: v.x, y: v.y, z: v.z! + a.z, rx: v.rx! + a.rx, scale: v.s, flat: f.t >= f.duration && F === 0 });
        const sn = this.$(el);
        sn.vars['--c'] = (0.15 + 0.85 * Math.max(v.front!, F)).toFixed(3);
        sn.classes['is-cur'] = i === this.st.cur;
        sn.classes['is-back'] = i !== this.st.cur || this.st.fan;
        sn.classes['is-fan'] = F > 0.5;
        for (const c of this.cards[i]!) {
          const d = hoverLit ? (hoverLit.has(c.id) ? 1 : DIM_HOVER) : this.morph.value(`d:${c.id}`)!.d!;
          const n = this.$(c.el);
          n.opacity = d;
          n.classes['is-lit'] = i === this.st.cur && !!lit && lit.nodes.has(c.id);
          n.classes['is-diff'] = F > 0.5 && diffNodes[i]!.has(c.id);
        }
      });
      // matrices for this frame, so the tabs can sit on the sheets' projected top edges; they are flat
      // (never occluded), so they dip while the stack opens or closes, when edges pass behind other sheets
      this.space.render();
      const tabOp = 0.1 + 0.9 * Math.abs(2 * F - 1) ** 0.7;
      const tabX = (i: number) => 14 + i * (this.g.TW + 6);
      views.forEach((_, i) => {
        const p = this.space.at(this.sheets[i]!, tabX(i) / this.g.SW, 0);
        const t = this.$(`#st-tab-${i}`);
        // flat stack: tabs keep their column (only their height follows the sheet); overview: they ride the sheet
        t.set({ x: MX + tabX(i) + (p.x - MX - tabX(i)) * F, y: p.y - this.g.b.tab + 1, opacity: tabOp });
        t.classes['is-cur'] = i === this.st.cur;
        t.classes['is-float'] = F > 0.5;
      });
      // the hovered tab's slice, in a few lines (built when the tab changes), just under the tab, inside the plate
      const tb = this.st.tab ?? null, ab = this.$(this.el.about);
      if (tb === null || !views[tb]) { if (!this.el.about.hidden) this.el.about.hidden = true; this.aboutFor = ''; }
      else {
        const key = `${tb}|${this.st.cur}`;
        if (this.aboutFor !== key) { this.el.about.innerHTML = this.aboutHTML(tb); this.aboutFor = key; this.el.about.hidden = false; }
        const t = this.$(`#st-tab-${tb}`);
        ab.set({ x: clamp(t.x, 8, this.g.W - 420 - 8), y: t.y + this.g.b.tab + 6 });
      }
      // a warning item's card (hovered or pinned): what it concerns, each party's part, the outcome, a button per party
      const wk = F > 0.5 ? null : this.shownWarn(), wc = this.el.wc;
      if (wk === null) { if (!wc.hidden) wc.hidden = true; this.warnFor = ''; }
      else {
        const i = this.st.cur, w = views[i]!.slice.warning!, it = itemsOf[i]![wk]!, pinned = this.st.warnPin === wk;
        const key = `${i}|${wk}|${pinned}`;
        if (this.warnFor !== key) {
          const mean = it.meaning ?? w.meaning;
          wc.innerHTML = warningCardHTML({ n: wk + 1, of: itemsOf[i]!.length, name: it.name ?? w.name ?? 'warning', ...(it.sym ? { sym: it.sym } : {}), title: it.title, ...(mean ? { meaning: mean } : {}), lines: (it.lines ?? []).map((l) => ({ ...l, ...(typeof l.open === 'number' && o.open && views[l.open] ? {} : { open: undefined }) })), ...(it.result ? { result: it.result } : {}), ...(it.actions?.length && o.itemAction ? { actions: it.actions } : {}) }, { pinned });
          wc.classList.toggle('is-pinned', pinned);
          wc.classList.toggle('is-note', it.tone === 'note');
          wc.classList.toggle('is-ask', it.tone === 'ask');
          wc.setAttribute('aria-label', `${it.name ?? w.name ?? 'warning'} ${wk + 1}: ${it.title}`);
          wc.hidden = false;
          this.warnFor = key;
        }
        const { at, avoid } = this.warnAnchor(wk);
        // never over what it was pointed at (its ⚠, to click it), then off its cards
        // inside the visible part, clear of the chrome and at its fit size while zoomed (docs/ENGINE.md "Zoom and pan";
        // at the chrome floor's size: "Chrome floor")
        const view = this.stage.view, k = view.cardScale;
        const pos = view.overlay(at, WIRE_CARD_W, wc.offsetHeight || 220, avoid, (a, w, h, W, H, av) => placeCard(a, w, h, W, H, av, [{ x: a.x - 14 * k, y: a.y - 14 * k, w: 28 * k, h: 28 * k }]));
        this.$(wc).set(pos);
      }
      // the shown item's ⚠ marks are filled in
      const onKeys = new Set(wk === null ? [] : itemsOf[this.st.cur]![wk]!.pairs ?? []);
      for (const m of this.sheets[this.st.cur]!.querySelectorAll<HTMLElement>('.st-mark.is-warn')) m.classList.toggle('is-on', onKeys.has(m.dataset.key!));
    }
    /** A slice's about card: its title, badge and subtitle, what it is (`about`, at most eight lines), its warning, and
     *  what a click does. */
    private aboutHTML(i: number) {
      const sl = views[i]!.slice, ab = sl.about ?? [], MAX = 8;
      const lines = ab.slice(0, ab.length > MAX ? MAX - 1 : MAX);
      const w = sl.warning, its = w?.items ?? [];
      const ws = !w ? [] : its.length
        ? [`${w.text}${w.meaning && its.every((it) => (it.name ?? w.name) === w.name) ? `: ${w.meaning}` : ''}`, ...its.map((it, k) => `${k + 1} · ${it.name ? `${it.name}: ` : ''}${it.title}${it.who?.length ? ` (${it.who.join(' and ')})` : ''}`)]
        : [w.text.split(': ')[0]!, ...(w.details ?? [])];
      const act = o.open ? (i === this.st.cur ? `click the ${noun} or Enter: ${o.open.label(i).toLowerCase()}` : `click the tab to bring it forward, then Enter: ${o.open.label(i).toLowerCase()}`) : '';
      return `<div class="hd"><span class="pl-label">${noun} ${i + 1}</span><b>${esc(sl.title)}</b>${sl.badge ? `<span class="st-bdg">${esc(sl.badge)}</span>` : ''}</div>
        ${sl.subtitle ? `<div class="sub">${esc(sl.subtitle)}</div>` : ''}
        ${ws.length ? `<ol>${ws.map((x) => `<li class="w">${esc(x)}</li>`).join('')}</ol>` : ''}
        ${lines.length ? `<ol>${lines.filter((x) => !x.startsWith('⚠ ')).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
        ${ab.length > lines.length ? `<div class="more">+${ab.length - lines.length} more</div>` : ''}
        ${act ? `<div class="hint">${esc(act)}</div>` : ''}`;
    }

    draw(f: Frame, fx: Fx) {
      fx.under.bg.pattern = 'dots'; fx.under.bg.patternAlpha = 0.18;
      const F = this.morph.value('f')!.f!;
      const proj = (i: number, p: P) => this.proj(i, p);
      // overview: guide lines between matching corners of neighbouring sheets
      if (F > 0.02) for (let i = 0; i < N - 1; i++) for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        const a = this.space.at(this.sheets[i]!, u, v), b = this.space.at(this.sheets[i + 1]!, u, v);
        fx.under.lines.dashes(new Path([a, b]), { dash: 4, gap: 5, width: 1, color: 'line', alpha: 0.7 * F });
      }
      const Ln = fx.over!.lines;
      const lit = this.lit();
      // the about card sits over the wires' layer's place: they leave a hole there
      // (and the warning card)
      // (the about card is chrome, in fit coordinates: where it is drawn while zoomed)
      const holes = [this.el.about, this.el.wc].filter((el) => !el.hidden).map((el) => (el === this.el.about ? this.stage.chrome.box(this.$(el).bounds(2)) : this.$(el).bounds(2)));
      const inHole = (q: P) => holes.some((h) => q.x > h.x && q.x < h.x + h.w && q.y > h.y && q.y < h.y + h.h);
      views.forEach((v, i) => {
        const fr = this.morph.value(`s:${i}`)!.front!, wa = fr * fr * (1 - F);   // squared: a crisp hand-over mid-slide
        if (wa < 0.01) return;
        const cur = i === this.st.cur;
        const draw = (e: Wire, ghost: boolean) => {
          const lp = localPath(this.g, e), full = new Path(lp.pts.map((q) => proj(i, q)));
          const key = e.key, mu = markAt[i]!.get(key);
          // a wire with a change glyph on it leaves room for the glyph
          const parts = (mu === undefined ? [full] : [full.slice(0, mu - 11 / full.length), full.slice(mu + 11 / full.length, 1)]).flatMap((q) => holes.reduce((ps, h) => ps.flatMap((x) => cutOut(x, h)), [q]));
          const p = full;
          const on = cur && !!lit && (lit.keys.has(key) || (lit.ends.has(e.from) && lit.ends.has(e.to)));
          // what a what-if does to it: gone (removed, rerouted) is a ghost; proposed is the accent, long dashes
          const mk = edgeMark(i, key), warn = warnPairs[i]!.has(key);
          ghost ||= gone(i, key);
          const alpha = wa * (on ? 1 : lit ? 0.18 : ghost ? 0.6 : 1);
          if (warn) {
            // a relationship the slice warns about (a conflict) has its own look, whatever it is otherwise: a dotted line in
            // the warning colour over a faint halo, with its ⚠, so it never reads as "seen, not declared" (which a theme
            // may draw in the same colour); the card says what each side does to it
            const a = on || !lit ? wa : alpha;
            for (const q of parts) Ln.path(q, { color: 'accent2', width: on ? 9 : 7, alpha: (on ? 0.28 : 0.15) * a });
            for (const q of parts) Ln.dashes(q, { dash: 2, gap: 4, width: on ? 2.8 : 2.4, color: 'accent2', alpha: a, glow: on ? 1.2 : 0 });
            const end = p.at(0.999);
            if (!inHole(end)) Ln.arrow(end, end.angle, 7, { color: 'accent2', width: 1.5, alpha: a });
            return;
          }
          if (ghost) {
            for (const q of parts) Ln.dashes(q, { dash: 2, gap: 5, width: 1.6, color: on ? 'accent' : 'muted', alpha, glow: on ? 1.2 : 0 });
            const end = p.at(0.999);
            if (!inHole(end)) Ln.arrow(end, end.angle, 6, { color: 'muted', width: 1.2, alpha });
            return;
          }
          if (mk === 'proposed' || e.style === 'proposed') {
            const c = on || !lit ? 'accent' : 'line', a = on || !lit ? wa : alpha;
            for (const q of parts) Ln.dashes(q, { color: c, width: 2.2, alpha: a, glow: on || !lit ? 1.4 : 0, dash: 9, gap: 5 });
            const end = p.at(0.999);
            if (!inHole(end)) Ln.arrow(end, end.angle, 8, { color: c, width: 1.6, alpha: a });
            return;
          }
          // style from the model's verdict: solid (seen), dashed (declared, not seen), warning colour (seen, not declared)
          const color = on ? 'accent' : e.style === 'warn' ? 'accent2' : 'line';
          const stroke = { color, width: on ? 1.9 : 1.5, alpha, glow: on ? 1.5 : 0 } as const;
          for (const q of parts) { if (e.style === 'dashed') Ln.dashes(q, { ...stroke, dash: 5, gap: 5 }); else if (e.style === 'idle') Ln.dashes(q, { ...stroke, dash: 1.5, gap: 4 }); else Ln.path(q, stroke); }
          const end = p.at(0.999);
          if (!inHole(end)) Ln.arrow(end, end.angle, 7, { color, width: 1.4, alpha });
        };
        for (const e of v.ghostWires) draw(e, true);
        for (const e of v.wires) draw(e, false);
      });
    }
  };
}
