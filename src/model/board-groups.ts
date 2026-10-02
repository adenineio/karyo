// Group navigation for the structure board (docs/ENGINE.md "Group navigation"): a level above the cards. A big board
// starts as a map of its groups, one card per group (its counts, categories, a few headline members, what calls into it
// and what it calls), with one wire per pair of groups counting the relationships it stands for. Entering a group shows
// that group's own scene: its direct cards and its subgroups (curation groups nest through `parent`) as group cards, and
// at the edges the neighbours that connect to it, as inlet and outlet stubs. Pure: what a level draws is a function of the
// model, the group hierarchy and the level; the board (board.ts) draws it with its usual machinery and animates the
// change of level with `planLevel` (a camera move: the entered card grows into the scene, the rest slides away).
//
// Shape-neutral: groups are the model's groups (a node's `group`, nesting from `groups[].parent`), nothing else.
import { pairKey, wireStyle, type MNode, type MGroup, type MEdge, type Wire, type Verdict, type EdgeKind, type Model, type NodeKind } from './model';
import { layout, esc, COL_GAP, ROW_GAP, TOP, SIDE, type Layout, type CardSlot, type CardBox } from './scenes';
import { listing, type WireInfo, type RecordedCall } from './wire-info';
import type { KitSet } from '../kits/registry';

/** A group card's id (and a group stub's): never a valid node id (ids are ASCII words). */
export const GPRE = '·g:';
export const isGroupItem = (id: string) => id.startsWith(GPRE);
export const groupOfItem = (id: string) => id.slice(GPRE.length);
/** Nodes outside every group: actors (drawn at the top level as themselves). Ungrouped others sit in `other`. */
export const OUTSIDE = '·outside', OTHER = 'other';
/** Bands a level lays out: the top level's group cards (no frame), the inlets and the outlets. */
export const TOP_BAND = '·top', IN_BAND = '·in', OUT_BAND = '·out';
/** A synthetic kind for group cards (no kit can declare it: kinds are lowercase words). */
export const GROUP_KIND = '·group' as NodeKind;
export const GCARD: CardBox = { w: 248, h: 140 };
export const STUB: CardBox = { w: 176, h: 52 };
/** How far below the header a level's content starts (the breadcrumb takes a line). */
export const CRUMB_H = 22;
/** Auto: a board with this many cards or more starts on its groups (when it has two groups or more to show). */
export const GROUPS_AT = 28;

// ------------------------------------------------------------------ the hierarchy
export interface Hier {
  /** Every group that holds a card somewhere below it. */
  all: Set<string>;
  parent(g: string): string | null;
  /** A node's own group (OUTSIDE for an actor, OTHER when it has none). */
  leaf(id: string): string;
  /** A group, its parent, … up to its top-level group. */
  chain(g: string): string[];
  /** The groups right under a level (null: the top). */
  children(at: string | null): string[];
  /** Node ids a level draws as themselves: the group's direct cards (the top: the actors). */
  directs(at: string | null): string[];
  /** Node ids in a group's subtree (null: every node). */
  under(g: string | null): string[];
  /** A group's own label (its id when it has none). */
  label(g: string): string;
  /** Labels from the top down to the group. */
  path(g: string | null): string[];
  /** The level a node is drawn on as itself. */
  levelOf(id: string): string | null;
  /** Two levels or more to show (else the overview is pointless). */
  available: boolean;
}

/** `keep`: groups to show even with no card in them yet (a group a splice proposes). */
export function hierarchy(nodes: MNode[], groups: MGroup[] = [], keep: Iterable<string> = []): Hier {
  const by = new Map(groups.map((g) => [g.id, g]));
  const leafOf = new Map(nodes.map((n) => [n.id, n.kind === 'actor' ? OUTSIDE : n.group ?? OTHER]));
  const parent = (g: string): string | null => { const p = by.get(g)?.parent; return p && p !== g ? p : null; };
  const chainMemo = new Map<string, string[]>();
  const chain = (g: string): string[] => {
    let c = chainMemo.get(g);
    if (c) return c;
    c = [];
    for (let x: string | null = g; x !== null && !c.includes(x); x = parent(x)) c.push(x);
    chainMemo.set(g, c);
    return c;
  };
  const all = new Set<string>();
  for (const lf of leafOf.values()) if (lf !== OUTSIDE) for (const g of chain(lf)) all.add(g);
  for (const k of keep) for (const g of chain(k)) all.add(g);
  const sorted = [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const kids = new Map<string | null, string[]>();
  for (const g of sorted) { const p = chain(g)[1] ?? null; (kids.get(p) ?? kids.set(p, []).get(p)!).push(g); }
  const underMemo = new Map<string | null, string[]>();
  const under = (g: string | null) => {
    let u = underMemo.get(g);
    if (!u) { u = g === null ? nodes.map((n) => n.id) : nodes.filter((n) => { const lf = leafOf.get(n.id)!; return lf !== OUTSIDE && chain(lf).includes(g); }).map((n) => n.id); underMemo.set(g, u); }
    return u;
  };
  const label = (g: string) => by.get(g)?.label ?? g;
  const top = kids.get(null) ?? [];
  const directsTop = nodes.filter((n) => leafOf.get(n.id) === OUTSIDE).length;
  return {
    all, parent: (g) => chain(g)[1] ?? null, leaf: (id) => leafOf.get(id) ?? OTHER, chain, under, label,
    children: (at) => kids.get(at) ?? [],
    directs: (at) => nodes.filter((n) => (at === null ? leafOf.get(n.id) === OUTSIDE : leafOf.get(n.id) === at)).map((n) => n.id),
    path: (g) => (g === null ? [] : [...chain(g)].reverse().map(label)),
    levelOf: (id) => { const lf = leafOf.get(id) ?? OTHER; return lf === OUTSIDE ? null : lf; },
    available: top.length + (directsTop ? 1 : 0) >= 2 || (top.length === 1 && (kids.get(top[0]!) ?? []).length >= 1),
  };
}

/** What a real node is drawn as on a level: itself, the group card it is inside, or (outside the level's group) a stub:
 *  itself or its group as seen from the closest level that holds both. */
export function repOf(h: Hier, id: string, at: string | null): { item: string; stub: boolean } {
  const lf = h.leaf(id);
  const ch = lf === OUTSIDE ? [] : h.chain(lf);
  const topOf = () => (lf === OUTSIDE ? id : GPRE + ch[ch.length - 1]!);
  if (at === null) return { item: topOf(), stub: false };
  const i = ch.indexOf(at);
  if (i === 0) return { item: id, stub: false };
  if (i > 0) return { item: GPRE + ch[i - 1]!, stub: false };
  const lca = h.chain(at).find((g) => ch.includes(g)) ?? null;
  if (lca === null) return { item: topOf(), stub: true };
  const j = ch.indexOf(lca);
  return { item: j === 0 ? id : GPRE + ch[j - 1]!, stub: true };
}

// ------------------------------------------------------------------ one level
export type ItemRole = 'node' | 'group' | 'stub-node' | 'stub-group';
export interface LevelItem {
  id: string;
  role: ItemRole;
  /** The group a group card or group stub stands for; a node's id for a node or node stub. */
  ref: string;
  /** The real node ids it stands for (a group: every node in its subtree). */
  members: string[];
  /** A stub's edge: inlets (they call in) on the left, outlets on the right. */
  side?: 'in' | 'out';
}
export interface LevelView {
  at: string | null;
  L: Layout;
  items: Map<string, LevelItem>;
  /** Each real node's drawn item on this level (only nodes that are drawn: inside it, or a connected neighbour). */
  rep: Map<string, string>;
  /** A drawn wire that stands for several relationships (a group's): the real wires under it. */
  under: Map<string, Wire[]>;
  /** In a splice: an aggregate wire's mark (every relationship under it proposed, or removed). */
  marks: Map<string, string>;
  /** Bands drawn without a frame (the top level's group cards). */
  bare: Set<string>;
}

const KIND_ORDER: EdgeKind[] = ['calls', 'reads', 'writes', 'publishes', 'subscribes', 'imports'];
const VERDICT_RANK: Verdict[] = ['confirmed', 'entry', 'extracted', 'unseen', 'unexercised', 'undeclared', 'possible', 'proposed'];
const kindsOfWire = (w: Wire): EdgeKind[] => (w.kinds.length ? w.kinds : [w.edge.kind]);

/** One wire for several relationships: their kinds, sources, recorded counts; its verdict the most common of the solid
 *  ones (any seen relationship makes it solid), else the most common. */
export function aggregateWire(from: string, to: string, under: Wire[]): Wire {
  const kinds = KIND_ORDER.filter((k) => under.some((w) => kindsOfWire(w).includes(k)));
  const sources = [...new Set(under.flatMap((w) => w.edge.sources))];
  const count = under.reduce((a, w) => a + (w.count ?? 0), 0);
  const n = new Map<Verdict, number>();
  for (const w of under) n.set(w.verdict, (n.get(w.verdict) ?? 0) + 1);
  const pick = (vs: Verdict[]) => vs.sort((a, b) => n.get(b)! - n.get(a)! || VERDICT_RANK.indexOf(a) - VERDICT_RANK.indexOf(b))[0];
  const solid = [...n.keys()].filter((v) => wireStyle(v) === 'solid');
  const verdict = (solid.length ? pick(solid) : pick([...n.keys()]))!;
  const edge: MEdge = { from, to, kind: kinds[0] ?? 'calls', ...(kinds.length > 1 ? { kinds } : {}), count, sources };
  // (the style its relationships of that verdict are drawn in: solid in a model with no recorded run, model.ts `hasRuns`)
  return { key: pairKey(from, to), from, to, edge, kinds, count, verdict, style: under.find((w) => w.verdict === verdict)?.style ?? wireStyle(verdict), decl: under.some((w) => w.decl), seen: under.some((w) => w.seen) };
}

/** What a level draws: its items, laid out (the inner part layered as the board lays out a model; inlets in a column on
 *  the left, outlets on the right), and its wires (a pair of real cards keeps its own; anything with a group at an end is
 *  one wire per pair of items). */
export function levelView(o: { Lc: Layout; hier: Hier; at: string | null; kits: KitSet; marks?: { edges: Record<string, string> } | null }): LevelView {
  const { Lc, hier: h, at } = o;
  const node = new Map(Lc.nodes.map((n) => [n.id, n]));
  const rep = new Map<string, { item: string; stub: boolean }>();
  for (const n of Lc.nodes) rep.set(n.id, repOf(h, n.id, at));
  const agg = new Map<string, { from: string; to: string; under: Wire[] }>();
  for (const w of Lc.wires) {
    const A = rep.get(w.from)!, B = rep.get(w.to)!;
    if (A.item === B.item || (A.stub && B.stub)) continue;
    const k = pairKey(A.item, B.item);
    (agg.get(k) ?? agg.set(k, { from: A.item, to: B.item, under: [] }).get(k)!).under.push(w);
  }
  // the items: everything inside the level, and the stubs something inside connects to
  const items = new Map<string, LevelItem>();
  const add = (item: string, stub: boolean) => {
    if (items.has(item)) return;
    const g = isGroupItem(item) ? groupOfItem(item) : null;
    items.set(item, { id: item, role: g ? (stub ? 'stub-group' : 'group') : stub ? 'stub-node' : 'node', ref: g ?? item, members: g ? h.under(g) : [item] });
  };
  for (const n of Lc.nodes) { const r = rep.get(n.id)!; if (!r.stub) add(r.item, false); }
  // a group with no card in it yet (a splice's proposal) still has its card on its level
  for (const g of h.children(at)) add(GPRE + g, false);
  const stubItem = new Set([...rep.values()].filter((r) => r.stub).map((r) => r.item));
  for (const a of agg.values()) for (const id of [a.from, a.to]) if (stubItem.has(id)) add(id, true);
  // which edge a stub sits on: inlets call in, outlets are called (the more relationships win; a tie: an inlet)
  const ins = new Map<string, number>(), outs = new Map<string, number>();
  for (const a of agg.values()) {
    const fa = items.get(a.from)!, ta = items.get(a.to)!;
    if (fa.role.startsWith('stub')) ins.set(a.from, (ins.get(a.from) ?? 0) + a.under.length);
    if (ta.role.startsWith('stub')) outs.set(a.to, (outs.get(a.to) ?? 0) + a.under.length);
  }
  for (const it of items.values()) if (it.role.startsWith('stub')) it.side = (ins.get(it.id) ?? 0) >= (outs.get(it.id) ?? 0) && ins.has(it.id) ? 'in' : 'out';
  // nodes for the layout: real cards as they are; group cards and stubs as nodes of their own
  const band = at ?? TOP_BAND;
  const mnode = (it: LevelItem): MNode => {
    if (it.role === 'node') return node.get(it.id)!;
    if (it.role === 'stub-node') { const n = node.get(it.id)!; return { ...n, kind: n.kind === 'actor' ? 'external' : n.kind, group: it.side === 'in' ? IN_BAND : OUT_BAND }; }
    return { id: it.id, kind: GROUP_KIND, label: h.label(it.ref), group: it.role === 'group' ? band : it.side === 'in' ? IN_BAND : OUT_BAND, sources: [] };
  };
  const inner = [...items.values()].filter((it) => !it.role.startsWith('stub'));
  const innerIds = new Set(inner.map((it) => it.id));
  const mini: Model = {
    karyo: 1, nodes: inner.map(mnode), flows: [],
    edges: [...agg.values()].filter((a) => innerIds.has(a.from) && innerIds.has(a.to)).map((a) => ({ from: a.from, to: a.to, kind: 'calls', sources: ['declared'] })),
  };
  const sizes = Object.create(o.kits) as KitSet;
  sizes.size = (k: string | undefined) => (k === GROUP_KIND ? { ...GCARD } : o.kits.size(k));
  const L0 = layout(mini, undefined, 0, 0, sizes);
  // the stub columns: inlets left of everything, outlets right of it, each ordered by where its cards are
  const stubs = (side: 'in' | 'out') => [...items.values()].filter((it) => it.side === side);
  const inS = stubs('in'), outS = stubs('out');
  const dx = inS.length ? STUB.w + COL_GAP : 0, dl = inS.length ? 1 : 0;
  const pos = new Map<string, CardSlot>(), size = new Map<string, CardBox>();
  for (const [id, p] of L0.pos) { pos.set(id, { x: p.x + dx, y: p.y + CRUMB_H, layer: p.layer + dl, right: (p.right ?? p.x) + dx }); size.set(id, L0.size.get(id)!); }
  const colX = [...(inS.length ? [SIDE] : []), ...L0.colX.map((x) => x + dx)];
  const colW = [...(inS.length ? [STUB.w] : []), ...L0.colW];
  const groupsOut: Layout['groups'] = L0.groups.map((g) => ({ ...g, x: g.x + dx, y: g.y + CRUMB_H, label: g.id === TOP_BAND ? '' : g.id === OUTSIDE ? 'outside' : h.label(g.id) }));
  const wireEnds = (id: string) => [...agg.values()].filter((a) => a.from === id || a.to === id).flatMap((a) => [a.from, a.to]).filter((x) => x !== id && pos.has(x));
  const placeColumn = (list: LevelItem[], layer: number, bandId: string, label: string) => {
    if (!list.length) return;
    const cy = (it: LevelItem) => { const ys = wireEnds(it.id).map((x) => pos.get(x)!.y); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0; };
    const order = [...list].sort((a, b) => cy(a) - cy(b) || (a.id < b.id ? -1 : 1));
    const x = colX[layer]!, y0 = TOP + CRUMB_H;
    order.forEach((it, i) => { pos.set(it.id, { x, y: y0 + 22 + i * (STUB.h + ROW_GAP), layer, right: x + STUB.w }); size.set(it.id, { ...STUB }); });
    groupsOut.push({ id: bandId, label, x: x - 14, y: y0, w: STUB.w + 28, h: 22 + order.length * (STUB.h + ROW_GAP) - ROW_GAP + 14 });
  };
  placeColumn(inS, 0, IN_BAND, 'inlets');
  if (outS.length) { const l = colX.length; colX.push(colX[l - 1]! + colW[l - 1]! + COL_GAP); colW.push(STUB.w); placeColumn(outS, l, OUT_BAND, 'outlets'); }
  // wires: a pair of real cards keeps its own wire (and key); anything else is one wire per pair of items
  const under = new Map<string, Wire[]>(), marks = new Map<string, string>();
  const wires: Wire[] = [];
  for (const [k, a] of agg) {
    const one = a.under.length === 1 && a.under[0]!.from === a.from && a.under[0]!.to === a.to;
    if (one) { wires.push(a.under[0]!); continue; }
    wires.push(aggregateWire(a.from, a.to, a.under));
    under.set(k, a.under);
    const ms = o.marks ? a.under.map((w) => o.marks!.edges[w.key] ?? null) : [];
    if (ms.length && ms.every((m) => m === 'proposed')) marks.set(k, 'proposed');
    else if (ms.length && ms.every((m) => m === 'removed' || m === 'rerouted')) marks.set(k, 'removed');
  }
  const nodes = [...items.values()].map(mnode);
  const right = Math.max(0, ...[...pos].map(([id, p]) => p.x + size.get(id)!.w));
  const bottom = Math.max(TOP, ...groupsOut.map((g) => g.y + g.h));
  const L: Layout = { nodes, wires, wire: new Map(wires.map((w) => [w.key, w])), pos, size, colX, colW, groups: groupsOut, layers: colX.length, W: Math.max(960, right + SIDE), H: bottom + 64 };
  const repOut = new Map<string, string>();
  for (const [id, r] of rep) if (items.has(r.item)) repOut.set(id, r.item);
  return { at, L, items, rep: repOut, under, marks, bare: new Set([TOP_BAND]) };
}

// ------------------------------------------------------------------ words
const VERDICT_WORDS: Record<Verdict, string> = {
  confirmed: 'seen in recorded runs', unseen: 'declared, never seen', extracted: 'in the code, not seen', unexercised: 'not exercised',
  undeclared: 'seen, not declared', entry: 'callers from outside', possible: 'possible', proposed: 'proposed',
};
/** In a model with no recorded run (model.ts `hasRuns`): what the code has, with no "never seen". */
const NO_RUNS_WORDS: Partial<Record<Verdict, string>> = { unseen: 'declared', extracted: 'in the code' };
/** "12 calls from App into Data", or "5 relationships from App into Data: 3 calls, 2 reads". */
export function aggregateSentence(A: string, B: string, under: Wire[]): string {
  const n = under.length;
  const per = KIND_ORDER.map((k) => [k, under.filter((w) => kindsOfWire(w).includes(k)).length] as const).filter(([, c]) => c > 0);
  if (per.length === 1) return `${n} ${per[0]![0] === 'calls' ? (n === 1 ? 'call' : 'calls') : `${n === 1 ? 'relationship' : 'relationships'} (${per[0]![0]})`} from ${A} into ${B}.`;
  return `${n} relationship${n === 1 ? '' : 's'} from ${A} into ${B}: ${listing(per.map(([k, c]) => `${c} ${k}`), 5)}.`;
}
/** The wire card's words for an aggregate wire: how many relationships, of which kinds, how they stand, which pairs. */
export function aggregateInfo(w: Wire, under: Wire[], calls: RecordedCall[], label: (id: string) => string, o: { runs?: boolean } = {}): WireInfo {
  const A = label(w.from), B = label(w.to);
  const firstSeen: string[] = [];
  const n = new Map<string, number>();
  for (const c of calls) { const op = c.op || 'call'; if (!n.has(op)) firstSeen.push(op); n.set(op, (n.get(op) ?? 0) + 1); }
  const ops = [...n].sort((a, b) => b[1] - a[1] || firstSeen.indexOf(a[0]) - firstSeen.indexOf(b[0]));
  const vs = new Map<Verdict, number>();
  for (const x of under) vs.set(x.verdict, (vs.get(x.verdict) ?? 0) + 1);
  const verdictText = [...vs].sort((a, b) => b[1] - a[1] || VERDICT_RANK.indexOf(a[0]) - VERDICT_RANK.indexOf(b[0])).map(([v, c]) => `${c} ${(o.runs === false && NO_RUNS_WORDS[v]) || VERDICT_WORDS[v]}`).join(' · ');
  const pairs = under.map((x) => `${label(x.from)} → ${label(x.to)}`);
  return {
    key: w.key, from: w.from, to: w.to, fromLabel: A, toLabel: B, kinds: w.kinds, verdict: w.verdict, style: w.style, declared: w.decl,
    sentence: aggregateSentence(A, B, under), labelled: false, count: calls.length, ops, at: null,
    where: `between ${listing(pairs, 5)}`, direction: null, verdictText,
  };
}

// ------------------------------------------------------------------ cards
export interface GroupCardData {
  label: string;
  cards: number;
  groups: number;
  cats: { slot: number; name: string; n: number }[];
  headline: string[];
  ins: [string, number][];
  outs: [string, number][];
  proposed: number;
  /** The group itself is a splice's proposal. */
  proposedGroup?: boolean;
}
// An inlet / outlet line's room (GCARD less its padding, border and the arrow), in the monospace characters it is set in
// (11 px: a character is 0.6 em in the usual monospace faces; a name that is a little too long ellipsizes), and a separator's (" · ").
const IO_CHARS = (GCARD.w - 28 - 2 - 12) / 6.6, IO_SEP = 2.5;
/** Which of a line's neighbours to name: as many as fit whole (at most three, the busiest first), the rest as "+n". The
 *  line never cuts a count: a name that still doesn't fit is the part that ellipsizes (`.gc-l`). */
export function ioFit(xs: [string, number][], room = IO_CHARS): { shown: [string, number][]; more: number } {
  const len = ([l, c]: [string, number]) => l.length + 1 + String(c).length;
  let n = Math.min(3, xs.length);
  const width = (k: number) => xs.slice(0, k).reduce((a, x) => a + len(x), 0) + (k - 1) * IO_SEP + (k < xs.length ? IO_SEP + 1 + String(xs.length - k).length : 0);
  while (n > 1 && width(n) > room) n--;
  return { shown: xs.slice(0, n), more: xs.length - n };
}
const ioLine = (xs: [string, number][], none: string) => {
  if (!xs.length) return `<span class="gc-none">${none}</span>`;
  const { shown, more } = ioFit(xs);
  return [...shown.map(([l, c]) => `<span class="gc-it"><span class="gc-l">${esc(l)}</span><b>${c}</b></span>`), ...(more ? [`<span class="gc-more">+${more}</span>`] : [])].join('<span class="gc-sep">·</span>');
};
/** A group card's inside: what it holds, its categories, a few members, and what calls into it and what it calls. */
export function groupCardInner(d: GroupCardData): string {
  const cats = d.cats.slice(0, 4), more = d.cats.length - cats.length;
  const badge = d.proposedGroup ? '<span class="sp-badge proposed">proposed</span>' : d.proposed ? `<span class="sp-badge proposed">+${d.proposed} proposed</span>` : '';
  return `<div class="mm-top"><span class="mm-kind">${d.proposedGroup ? 'new group' : 'group'} · ${d.cards} card${d.cards === 1 ? '' : 's'}${d.groups ? ` · ${d.groups} group${d.groups === 1 ? '' : 's'}` : ''}</span>${badge}<span class="gc-go" aria-hidden="true">⤢</span></div>
    <div class="mm-name">${esc(d.label)}</div>
    <div class="gc-cats" data-pl-clip>${cats.map((c) => `<span class="gc-cat" data-cat="${c.slot}" title="${esc(c.name)}"><i></i>${c.n} ${esc(c.name)}</span>`).join('')}${more > 0 ? `<span class="gc-cat">+${more}</span>` : ''}</div>
    <div class="gc-head">${esc(d.headline.join(' · '))}</div>
    <div class="gc-io" data-pl-clip title="what calls into it: ${esc(d.ins.map(([l, c]) => `${l} ${c}`).join(', ') || 'nothing')}"><span class="gc-ar">←</span>${ioLine(d.ins, 'nothing calls in')}</div>
    <div class="gc-io" data-pl-clip title="what it calls: ${esc(d.outs.map(([l, c]) => `${l} ${c}`).join(', ') || 'nothing')}"><span class="gc-ar">→</span>${ioLine(d.outs, 'calls nothing outside')}</div>`;
}
/** A stub's inside: a compact ghost of the neighbouring group or card, and which way it connects. */
export function stubInner(d: { kind: string; label: string; side: 'in' | 'out'; cards?: number; proposed?: boolean }): string {
  return `<div class="mm-top"><span class="mm-kind">${esc(d.kind)}${d.cards !== undefined ? ` · ${d.cards} card${d.cards === 1 ? '' : 's'}` : ''}</span>${d.proposed ? '<span class="sp-badge proposed">proposed</span>' : ''}<span class="st-ar" aria-hidden="true">${d.side === 'in' ? '→' : '←'}</span></div>
    <div class="mm-name">${esc(d.label)}</div>`;
}

export const GROUPS_CSS = /* css */ `
  .mm-card.bd-gcard { display: grid; align-content: start; gap: 5px; padding: 10px 14px; box-shadow: 5px 5px 0 -1px var(--pl-card), 5px 5px 0 0 var(--pl-card-border); }
  .mm-card.bd-gcard .mm-name { font-size: 17px; }
  .bd-gcard .gc-go { margin-left: auto; font: 13px/1 var(--pl-font-mono); color: var(--pl-muted); }
  .bd-gcard .mm-top { gap: 6px; }
  .bd-gcard .gc-cats { display: flex; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; font: 11px/1.2 var(--pl-font-mono); color: var(--pl-muted); }
  .bd-gcard .gc-cat { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .bd-gcard .gc-cat i { width: 8px; height: 8px; border-radius: 2px; background-color: var(--lg-c, var(--pl-line)); background-image: var(--lg-f, none); }
  .bd-gcard .gc-head { font-size: 12px; line-height: 1.3; color: var(--pl-fg); opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bd-gcard .gc-io { display: flex; gap: 5px; align-items: baseline; min-width: 0; font: 11px/1.25 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; }
  .bd-gcard .gc-io b { color: var(--pl-fg); font-weight: 600; }
  /* a neighbour and its count: the name ellipsizes, the count never shrinks */
  .bd-gcard .gc-it { display: inline-flex; gap: 1ch; align-items: baseline; min-width: 0; }
  .bd-gcard .gc-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .bd-gcard .gc-it b, .bd-gcard .gc-sep, .bd-gcard .gc-more { flex: none; }
  .bd-gcard .gc-ar { color: var(--pl-accent); flex: none; }
  .bd-gcard .gc-none { font-style: italic; }
  .mm-card.bd-stub { padding: 7px 12px; gap: 2px; border-style: dashed; background: color-mix(in srgb, var(--pl-card) 55%, transparent); box-shadow: none; }
  .mm-card.bd-stub .mm-name { font-size: 13.5px; opacity: 0.8; }
  .bd-stub .st-ar { margin-left: auto; font: 12px/1 var(--pl-font-mono); color: var(--pl-accent); }
  .bd-stub.is-lit, .bd-gcard.is-lit { border-color: var(--pl-accent); }
  /* a group a splice proposes: dashed and hatched like a proposed card */
  .mm-card.bd-gcard.sp-proposed, .mm-card.bd-stub.sp-proposed { border: 1.5px dashed var(--pl-accent); background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--pl-accent) 11%, transparent) 0 5px, transparent 5px 11px); }
  .mm-card.bd-gcard.sp-proposed { box-shadow: 5px 5px 0 -1px var(--pl-card), 5px 5px 0 0 color-mix(in srgb, var(--pl-accent) 55%, transparent), 0 0 0 3px color-mix(in srgb, var(--pl-accent) 14%, transparent); }
  /* a proposed group's placeholder: its empty state, in its own scene */
  .mm-card.bd-card.sp-ph { border-style: dashed; }
  .sp-ph .mm-top { gap: 6px; }
  .sp-ph .mm-name { flex: 1 1 auto; min-width: 0; font-style: italic; }
  .sp-ph .sp-empty { font: 11px/1.3 var(--pl-font-mono); color: var(--pl-muted); white-space: normal; }
  .bd-wn { position: absolute; left: 0; top: 0; z-index: 1; font: 600 10.5px/1 var(--pl-font-mono); padding: 3px 6px; border-radius: 999px; background: var(--pl-bg); border: 1px solid var(--pl-line); color: var(--pl-muted); white-space: nowrap; pointer-events: none; }
  .bd-wn.is-on { color: var(--pl-accent); border-color: var(--pl-accent); }
  .bd-crumbs { display: flex; align-items: center; gap: 6px; font: 500 12.5px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
  .bd-crumbs[hidden] { display: none; }
  .bd-crumbs button { font: inherit; color: var(--pl-muted); background: none; border: 0; padding: 1px 2px; cursor: pointer; }
  .bd-crumbs button:hover { color: var(--pl-fg); text-decoration: underline; }
  .bd-crumbs [aria-current] { color: var(--pl-accent); }
  .bd-crumbs .sep { opacity: 0.6; }
  .plate-dom.bd-groups .bd-drill { display: none; }
`;

// ------------------------------------------------------------------ the move between levels
export interface R { x: number; y: number; w: number; h: number }
const cx = (r: R) => r.x + r.w / 2, cy = (r: R) => r.y + r.h / 2;
export const bbox = (rs: R[]): R | null => {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
};
/** `r` scaled by k around its centre. */
const scaled = (r: R, k: number): R => ({ x: cx(r) - (r.w * k) / 2, y: cy(r) - (r.h * k) / 2, w: r.w * k, h: r.h * k });
/** Rects `rs` (laid out inside `from`) moved, as one picture, into `into` (uniform scale, centred). */
const mapInto = (rs: R[], into: R): ((r: R) => R) => {
  const b = bbox(rs)!;
  const k = Math.min(into.w / Math.max(1, b.w), into.h / Math.max(1, b.h));
  return (r) => ({ x: cx(into) + (r.x - cx(b)) * k, y: cy(into) + (r.y - cy(b)) * k, w: r.w * k, h: r.h * k });
};
/** Keep a rect inside the bounds (shrunk to fit, then moved in): nothing leaves the stage, even mid-move. */
export const clampRect = (r: R, b: R): R => {
  const k = Math.min(1, b.w / Math.max(1, r.w), b.h / Math.max(1, r.h));
  const s = k < 1 ? scaled(r, k) : r;
  return { x: Math.min(Math.max(s.x, b.x), b.x + b.w - s.w), y: Math.min(Math.max(s.y, b.y), b.y + b.h - s.h), w: s.w, h: s.h };
};

/** Where each item of the new level starts and where each item that goes ends, for a change of level. Continuity first:
 *  an item on both levels glides; a new item inside an old one grows out of it (members out of the group card you
 *  entered); a new item that holds old ones forms where they were (a group card as its members shrink into it); an item
 *  that goes either shrinks into what holds it or grows over what it held; everything else rides the camera (`focus`
 *  maps the old picture onto the new: entering a group, the overview slides away past the edges). All in the new
 *  level's stage px, kept inside `bounds`. Pure. */
export function planLevel(p: {
  before: Map<string, { r: R; o: number; members: string[] }>;
  after: Map<string, { r: R; members: string[] }>;
  focus: { from: R; to: R } | null;
  bounds: R;
}): { start: Map<string, { r: R; o: number }>; gone: Map<string, R> } {
  const z = p.focus ? Math.min(3.5, Math.max(1 / 3.5, Math.sqrt((p.focus.to.w * p.focus.to.h) / Math.max(1, p.focus.from.w * p.focus.from.h)))) : 1;
  const cam = (r: R): R => (p.focus ? { x: cx(p.focus.to) + (r.x - cx(p.focus.from)) * z, y: cy(p.focus.to) + (r.y - cy(p.focus.from)) * z, w: r.w * z, h: r.h * z } : r);
  const camInv = (r: R): R => (p.focus ? { x: cx(p.focus.from) + (r.x - cx(p.focus.to)) / z, y: cy(p.focus.from) + (r.y - cy(p.focus.to)) / z, w: r.w / z, h: r.h / z } : r);
  const sets = new Map<string, Set<string>>();
  const setOf = (id: string, ms: string[]) => { let s = sets.get(id); if (!s) { s = new Set(ms); sets.set(id, s); } return s; };
  const holds = (a: Set<string>, b: string[]) => b.length > 0 && b.every((m) => a.has(m));
  const B = [...p.before].map(([id, v]) => ({ id, ...v, set: setOf(`b:${id}`, v.members) }));
  const A = [...p.after].map(([id, v]) => ({ id, ...v, set: setOf(`a:${id}`, v.members) }));
  const start = new Map<string, { r: R; o: number }>(), gone = new Map<string, R>();
  const keep = (r: R) => clampRect(r, p.bounds);
  // new items
  const emerging = new Map<string, { a: (typeof B)[number]; kids: typeof A }>();
  for (const a of A) {
    const was = p.before.get(a.id);
    // the same item (a group card that is a stub here): from where it was, at its new shape (never stretched)
    if (was) { start.set(a.id, { r: keep({ ...scaled({ ...a.r, x: cx(was.r) - a.r.w / 2, y: cy(was.r) - a.r.h / 2 }, Math.sqrt((was.r.w * was.r.h) / Math.max(1, a.r.w * a.r.h))) }), o: was.o }); continue; }
    const outer = B.filter((b) => holds(b.set, a.members)).sort((x, y) => x.members.length - y.members.length)[0];
    if (outer) { const e = emerging.get(outer.id) ?? emerging.set(outer.id, { a: outer, kids: [] }).get(outer.id)!; e.kids.push(a); continue; }
    const parts = B.filter((b) => holds(a.set, b.members));
    if (parts.length) { const bb = bbox(parts.map((b) => b.r))!; start.set(a.id, { r: keep(scaled({ ...a.r, x: cx(bb) - a.r.w / 2, y: cy(bb) - a.r.h / 2 }, Math.min(1.6, Math.sqrt((bb.w * bb.h) / Math.max(1, a.r.w * a.r.h))))), o: 0 }); continue; }
    start.set(a.id, { r: keep(camInv(a.r)), o: 0 });
  }
  for (const { a, kids } of emerging.values()) {
    const into = mapInto(kids.map((k) => k.r), a.r);
    for (const k of kids) start.set(k.id, { r: keep(into(k.r)), o: 0 });
  }
  // items that go
  const shrinking = new Map<string, { a: (typeof A)[number]; kids: typeof B }>();
  for (const b of B) {
    if (p.after.has(b.id)) continue;
    const outer = A.filter((a) => holds(a.set, b.members)).sort((x, y) => x.members.length - y.members.length)[0];
    if (outer) { const e = shrinking.get(outer.id) ?? shrinking.set(outer.id, { a: outer, kids: [] }).get(outer.id)!; e.kids.push(b); continue; }
    const parts = A.filter((a) => holds(b.set, a.members));
    // (it grows toward them, but not so far that its words loom over the new scene)
    if (parts.length) { const bb = bbox(parts.map((a) => a.r))!; gone.set(b.id, keep(scaled({ ...b.r, x: cx(bb) - b.r.w / 2, y: cy(bb) - b.r.h / 2 }, Math.min(1.6, Math.sqrt((bb.w * bb.h) / Math.max(1, b.r.w * b.r.h)))))); continue; }
    gone.set(b.id, keep(cam(b.r)));
  }
  for (const { a, kids } of shrinking.values()) {
    const into = mapInto(kids.map((k) => k.r), a.r);
    for (const k of kids) gone.set(k.id, keep(into(k.r)));
  }
  return { start, gone };
}

/** What a board starts on: an explicit choice (the plate's option, else the model's `start`, from a curation file), else
 *  the groups when the board is big and has two groups or more to show. */
export function startView(opt: 'auto' | 'groups' | 'cards' | undefined, model: Pick<Model, 'start'>, h: Hier, cards: number): 'groups' | 'cards' {
  const want = opt && opt !== 'auto' ? opt : model.start ?? 'auto';
  if (!h.available) return 'cards';
  if (want === 'groups' || want === 'cards') return want;
  return cards >= GROUPS_AT ? 'groups' : 'cards';
}
