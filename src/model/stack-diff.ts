// The Stack view's data (src/model/stack.ts): an ordered list of slices of the same kind of thing
// (versions, layers, lanes, environments …), one shared layout over every slice's nodes so a node
// sits at the same place on every slice, and what changed from one slice to the next. Pure
// functions (no DOM), so the diff and the layout invariants can be tested without a browser.
//
// Identity follows the model's rule (docs/MODEL.md "Identity"): a node is its id, a relationship is its
// ordered pair. Every slice goes through `normalize` first, so a model that repeats a pair (a
// declared `reads` and an observed `calls` as two edges) is one relationship, and a slice never draws
// two wires for one pair.
import { normalize, wiresOf, kindsOf, type Model, type MNode, type Source, type Wire } from './model';
import { layout, type Layout } from './scenes';
import { kitsFor, type KitSet } from '../kits/registry';
import type { NodeMark, EdgeMark } from './splice';

export interface StackSlice {
  /** Stable id (e.g. a commit sha, a layer name). */
  id: string;
  /** Short title (the tab). */
  title: string;
  /** One more line (e.g. "sha · date"). */
  subtitle?: string;
  model: Model;
  /** What a what-if does to this slice's nodes and relationships (a splice's marks, src/model/splice.ts), drawn as the
   *  structure board draws an open splice: proposed dashed in the accent, removed or rerouted as ghosts, renamed or moved
   *  with a badge. Keys: node ids and `pairKey`s. */
  marks?: { nodes: Record<string, NodeMark>; edges: Record<string, EdgeMark> };
  /** What the slice is, in a few lines (hovering its tab shows them; e.g. a splice's changes in words). */
  about?: string[];
  /** A short word on its tab and in the header ("unsaved", "combined"). */
  badge?: string;
  /** A warning drawn on the slice and its tab: one line, more lines on hover, and the nodes and relationships
   *  (`pairKey`) it concerns (outlined in the warning colour and pattern; `name` is its legend entry, default "warning",
   *  and `meaning` what it means there, in plain words). `items`: the warning in numbered parts (e.g. each conflict),
   *  each listed in the header, lit on its own, and explained in a card on its ⚠ marks. */
  warning?: { text: string; name?: string; meaning?: string; details?: string[]; nodes?: string[]; pairs?: string[]; items?: WarningItem[]; /** `note`: nothing that needs a look (the header says it quietly). */ tone?: 'warn' | 'note' };
}
/** One numbered part of a slice's warning (src/model/stack.ts draws it: a list item, a card on hover or click). */
export interface WarningItem {
  /** What it concerns, in a few words (the list item and the card's heading). */
  title: string;
  /** Who is involved (the list item names them). */
  who?: string[];
  /** The cards and relationships (`pairKey`) it concerns: hovering it lights exactly these. */
  nodes?: string[];
  pairs?: string[];
  /** One line per party: who, what it does, and a slice that opens it (0-based; the view's `open.run`, a button). */
  lines?: { who: string; text: string; open?: number }[];
  /** How it ended up. */
  result?: string;
  /** What kind of item it is, when a warning has several kinds (e.g. "conflict", "agreed"): its name, symbol and meaning
   *  (its legend entry, list item and card say them), and its tone: `warn` (the warning colour, ⚠ on its wires), `ask`
   *  (a question for the person) or `note` (quiet: lit only when its item is hovered). Default: the warning's own. */
  name?: string; sym?: string; meaning?: string; tone?: 'warn' | 'ask' | 'note';
  /** Buttons its card offers besides opening a party (the host's `itemAction` runs them), e.g. "Treat as the same". */
  actions?: { id: string; label: string }[];
}
/** What each slice is compared with: `previous` (the neighbour diff: added / removed / changed here, the default) or
 *  `none` (each slice's own `marks` already say what it changes, against a common baseline). */
export type StackDiff = 'previous' | 'none';

/** Nodes a map draws: modules are the import scan's raw material, not the picture. */
export const drawnNodes = (m: Model): MNode[] => m.nodes.filter((n) => n.kind !== 'module');
/** The relationships a map draws, one per ordered pair (model.ts `wiresOf` over the normalized model), with verdict and style. */
export function drawnWires(m: Model): Wire[] {
  const ids = new Set(drawnNodes(m).map((n) => n.id));
  return wiresOf(normalize(m), (id) => ids.has(id));
}

const SRC_ORDER: Source[] = ['declared', 'extracted', 'observed', 'proposed'];
const srcs = (s: Source[] | undefined) => SRC_ORDER.filter((x) => (s ?? []).includes(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const list = (xs: string[]) => xs.join(' + ') || '—';

export interface NodeChange { id: string; what: string[] }
/** A relationship (an ordered pair, `pairKey`) as the diff names it. */
export interface PairRef { key: string; from: string; to: string }
export interface PairChange extends PairRef { what: string[] }
export interface SliceDiff {
  /** No previous slice: nothing to compare. */
  first: boolean;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: NodeChange[];
  /** Relationships (by pair) that appear, disappear, or change kinds, sources or whether runs counted them. */
  addedPairs: PairRef[];
  removedPairs: PairRef[];
  changedPairs: PairChange[];
}

/** What changed in a node between two slices: its identity-level fields, not its code location (line numbers move all the time). */
function nodeChanges(a: MNode, b: MNode): string[] {
  const out: string[] = [];
  if (a.kind !== b.kind) out.push(`kind: ${a.kind} → ${b.kind}`);
  if ((a.label ?? a.id) !== (b.label ?? b.id)) out.push(`label: ${a.label ?? a.id} → ${b.label ?? b.id}`);
  if ((a.group ?? '') !== (b.group ?? '')) out.push(`group: ${a.group ?? '—'} → ${b.group ?? '—'}`);
  if ((a.category ?? '') !== (b.category ?? '')) out.push(`category: ${a.category ?? '—'} → ${b.category ?? '—'}`);
  if (!same([...(a.tags ?? [])].sort(), [...(b.tags ?? [])].sort())) out.push(`tags: ${(a.tags ?? []).join(', ') || '—'} → ${(b.tags ?? []).join(', ') || '—'}`);
  if (!same(srcs(a.sources), srcs(b.sources))) out.push(`sources: ${list(srcs(a.sources))} → ${list(srcs(b.sources))}`);
  if ((a.summary ?? '') !== (b.summary ?? '')) out.push('summary');
  if ((a.lang ?? '') !== (b.lang ?? '')) out.push(`lang: ${a.lang ?? '—'} → ${b.lang ?? '—'}`);
  return out;
}
/** What changed in one relationship: its kinds, its sources, whether recorded runs counted it (not the count itself: every recording moves it). */
function pairChanges(a: Wire, b: Wire): string[] {
  const out: string[] = [];
  const ka = [...kindsOf(a.edge)].sort(), kb = [...kindsOf(b.edge)].sort();
  if (!same(ka, kb)) out.push(`kinds: ${list(ka)} → ${list(kb)}`);
  if (!same(srcs(a.edge.sources), srcs(b.edge.sources))) out.push(`sources: ${list(srcs(a.edge.sources))} → ${list(srcs(b.edge.sources))}`);
  const ca = typeof a.edge.count === 'number', cb = typeof b.edge.count === 'number';
  if (ca !== cb) out.push(cb ? 'now counted by recorded runs' : 'no longer counted by recorded runs');
  return out;
}

/** What `next` adds, removes and changes relative to `prev` (null: the first slice). Only what a map draws is compared. */
export function diffModels(prev: Model | null, next: Model): SliceDiff {
  if (!prev) return { first: true, addedNodes: [], removedNodes: [], changedNodes: [], addedPairs: [], removedPairs: [], changedPairs: [] };
  const na = new Map(drawnNodes(prev).map((n) => [n.id, n])), nb = new Map(drawnNodes(next).map((n) => [n.id, n]));
  const wa = new Map(drawnWires(prev).map((w) => [w.key, w])), wb = new Map(drawnWires(next).map((w) => [w.key, w]));
  const ref = (w: Wire): PairRef => ({ key: w.key, from: w.from, to: w.to });
  const changedNodes: NodeChange[] = [];
  for (const [id, b] of nb) { const a = na.get(id); if (a) { const what = nodeChanges(a, b); if (what.length) changedNodes.push({ id, what }); } }
  const changedPairs: PairChange[] = [];
  for (const [k, b] of wb) { const a = wa.get(k); if (a) { const what = pairChanges(a, b); if (what.length) changedPairs.push({ ...ref(b), what }); } }
  return {
    first: false,
    addedNodes: [...nb.keys()].filter((id) => !na.has(id)),
    removedNodes: [...na.keys()].filter((id) => !nb.has(id)),
    changedNodes,
    addedPairs: [...wb.values()].filter((w) => !wa.has(w.key)).map(ref),
    removedPairs: [...wa.values()].filter((w) => !wb.has(w.key)).map(ref),
    changedPairs,
  };
}

/** Every node and relationship any slice has (the latest slice's node records winning, so labels read as they do now): the shared layout's input. */
export function unionModel(slices: StackSlice[]): Model {
  const nodes = new Map<string, MNode>();
  for (const s of slices) for (const n of s.model.nodes) nodes.set(n.id, n);
  const last = slices[slices.length - 1]?.model;
  return normalize({ karyo: 1, project: last?.project, producers: last?.producers, nodes: [...nodes.values()], edges: slices.flatMap((s) => s.model.edges), flows: [] });
}

export interface SliceView {
  slice: StackSlice;
  /** Nodes this slice draws (all positioned by the shared layout). */
  nodes: MNode[];
  /** One wire per ordered pair. */
  wires: Wire[];
  /** Removed here: drawn as faint ghosts on this slice, from the previous slice's records. */
  ghostNodes: MNode[];
  ghostWires: Wire[];
  diff: SliceDiff;
}
export interface StackData {
  /** One layout over the union of every slice's nodes: the same node sits at the same place on every slice. */
  L: Layout;
  views: SliceView[];
}

/** `diff: 'none'`: nothing to compare with (no added / removed / changed here); `kits`: what the slices' kit kinds are
 *  drawn with (docs/KITS.md; their card sizes shape the layout). Default: the first slice's model's. */
export function stackData(slices: StackSlice[], o: { diff?: StackDiff; kits?: KitSet } = {}): StackData {
  if (!slices.length) throw new Error('karyo: stackView needs at least one slice');
  const L = layout(unionModel(slices), undefined, 0, 480, o.kits ?? kitsFor(slices[0]!.model));
  const views = slices.map((slice, i): SliceView => {
    // `none`: nothing to compare with (no added / removed / changed here, no ghosts from the neighbour)
    const prev = i > 0 && o.diff !== 'none' ? slices[i - 1]!.model : null;
    const diff = diffModels(prev, slice.model);
    const placed = (id: string) => L.pos.has(id);
    const nodes = drawnNodes(slice.model).filter((n) => placed(n.id));
    const wires = drawnWires(slice.model).filter((w) => placed(w.from) && placed(w.to));
    const pn = prev ? new Map(drawnNodes(prev).map((n) => [n.id, n])) : new Map<string, MNode>();
    const pw = prev ? new Map(drawnWires(prev).map((w) => [w.key, w])) : new Map<string, Wire>();
    const ghostNodes = diff.removedNodes.map((id) => pn.get(id)!).filter((n) => placed(n.id));
    const ghostWires = diff.removedPairs.map((r) => pw.get(r.key)!).filter((w) => placed(w.from) && placed(w.to));
    return { slice, nodes, wires, ghostNodes, ghostWires, diff };
  });
  return { L, views };
}

/** A diff's members for the legend: node ids (a relationship counts both its ends) and the pair keys it lights. */
export function diffMembers(d: SliceDiff) {
  const ends = (ps: PairRef[]) => ps.flatMap((p) => [p.from, p.to]);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    added: { nodes: uniq([...d.addedNodes, ...ends(d.addedPairs)]), pairs: d.addedPairs.map((p) => p.key) },
    removed: { nodes: uniq([...d.removedNodes, ...ends(d.removedPairs)]), pairs: d.removedPairs.map((p) => p.key) },
    changed: { nodes: uniq([...d.changedNodes.map((c) => c.id), ...ends(d.changedPairs)]), pairs: d.changedPairs.map((p) => p.key) },
  };
}
