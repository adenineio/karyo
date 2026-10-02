// Splices (docs/MODEL.md "Splices"): a what-if over any model. A splice is a named, saved list of proposed
// changes ("add a cache between A and B", "remove C") that `applySplice` draws in place: a NEW model where
// proposed nodes and relationships carry `sources: ['proposed']` and removed ones are kept, with marks
// saying what the splice does to each. Nothing is ever deleted from the real model, so every wire the
// plate drew is still there (as a ghost when the splice retires it) and every recorded call still lands
// on its relationship. Pure functions (no DOM, no fs): the browser, bun, the tests and Jarvis use them.
//
// Identity is the model's (src/model/model.ts): a node is its id, a relationship its ordered pair
// (`pairKey`); marks are keyed the same way.
//
// A card can stand for parts: a structure board draws a type with its methods folded into it (docs/MODEL.md "Fold"),
// so the wire between two type cards stands for the relationships between their methods. An op that names such a card
// means what the board shows: `between`, `before`, `after`, `disconnect` and `connect` read the relationships of its
// parts, `remove` and `replace` take its parts with it. `boardMarks` marks the board's folded wires.
import { ID_RE, RELATION_KINDS, foldRep, idFold, isImport, isProposed, kindsOf, nameFold, normalize, pairKey, type EdgeKind, type MEdge, type MGroup, type MNode, type Model, type NodeKind } from './model';

// ================================================================== format

export const SPLICE_FORMAT = 'splice/1' as const;
/** Where a project keeps its splices, relative to the folder holding its model. */
export const SPLICE_DIR = 'karyo/splices';
/** A splice file's repo-relative path: any folder, then `karyo/splices/<id>.splice.json`. */
export const SPLICE_FILE_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*karyo\/splices\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.splice\.json$/;
/** Splice ids are file names: no slashes, no leading dot. */
export const SPLICE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** The file a splice with this id lives in, next to the model in `projectDir` (repo-relative). */
export const spliceFile = (projectDir: string, id: string) => `${projectDir.replace(/\/+$/, '')}${projectDir ? '/' : ''}${SPLICE_DIR}/${id}.splice.json`;

/** A proposed node. `id` is `splice.<slug>`; without one, `applySplice` derives it from the label (`slugId`). */
export interface SpliceNode { id?: string; label: string; kind?: NodeKind; category?: string; tags?: string[]; group?: string; summary?: string }
/** One edge between the new node and `to`: `out` = new → to, `in` = to → new. Defaults: out, calls. */
export interface SpliceAttach { to: string; dir?: 'out' | 'in'; kind?: EdgeKind }
/** Where an added node goes: at most one of these (none: a free node). */
export type SplicePlace = { between: [string, string] } | { before: string } | { after: string } | { attach: SpliceAttach } | Record<string, never>;
export interface SpliceAddOp { op: 'add'; node: SpliceNode; between?: [string, string]; before?: string; after?: string; attach?: SpliceAttach }
/** `from` / `to` may also name a group this splice proposes: its entry card (its placeholder, else its first card). */
export interface SpliceConnectOp { op: 'connect'; from: string; to: string; kind?: EdgeKind; label?: string }
export interface SpliceDisconnectOp { op: 'disconnect'; from: string; to: string }
/** Remove a node, or (`group`) a group this splice proposes, with every card in it. */
export type SpliceRemoveOp = { op: 'remove' } & ({ node: string; group?: undefined } | { group: string; node?: undefined });
/** Rename a node, or (`group`) a group. */
export type SpliceRenameOp = { op: 'rename'; label: string } & ({ node: string; group?: undefined } | { group: string; node?: undefined });
/** Move a node into a group (its id or label; an unknown name is a new group with that id). */
export interface SpliceMoveOp { op: 'move'; node: string; group: string }
/** Swap X for Y: Y (a new node, or an existing one named by a ref) takes over every relationship of X, in and out; X
 *  stays as a removed ghost and its old relationships as rerouted ghosts. Later ops (and other splices combined after
 *  it) that name X follow the replacement to Y. */
export interface SpliceReplaceOp { op: 'replace'; node: string; with: SpliceNode | string }
/** A proposed group: `id` is `splice.<slug>` unless given; `parent` the group it sits in (an id or label; none: the top). */
export interface SpliceGroup { id?: string; label: string; parent?: string; summary?: string }
/** Propose a new group (docs/MODEL.md "Splices"): optionally its first card, and one relationship between the group and
 *  a node (`attach`: `in` = to → the group, the group is an outlet of `to`; `out` = the group → to). The relationship
 *  goes to the group's entry: its first card, else a placeholder card that stands for the group until a card is proposed
 *  into it (the first one takes over its relationships). */
export interface SpliceGroupOp { op: 'group'; group: SpliceGroup; first?: SpliceNode; attach?: SpliceAttach }
export type SpliceOp = SpliceAddOp | SpliceConnectOp | SpliceDisconnectOp | SpliceRemoveOp | SpliceRenameOp | SpliceMoveOp | SpliceReplaceOp | SpliceGroupOp;
export type SpliceOpName = SpliceOp['op'];
export const SPLICE_OPS: readonly SpliceOpName[] = ['add', 'connect', 'disconnect', 'remove', 'rename', 'move', 'replace', 'group'];

/** The model the splice was made against: its repo-relative path, the commit it was at (null: unknown or
 *  uncommitted), and the scene it was drawn on. */
export interface SpliceBase { model: string; commit: string | null; scene?: string }
export interface Splice {
  karyo: typeof SPLICE_FORMAT;
  id: string;
  title: string;
  note?: string;
  base: SpliceBase;
  /** The plate state to reopen at: opaque JSON owned by the UI. */
  view?: unknown;
  /** ISO timestamps. */
  created: string;
  updated: string;
  ops: SpliceOp[];
}

// ================================================================== result

export type NodeMark = 'proposed' | 'removed' | 'renamed' | 'moved';
/** `rerouted`: a real relationship the splice replaced by a path through a proposed node (between, before,
 *  after). Like `removed`, it is gone in the what-if and drawn as a ghost; the mark says why. */
export type EdgeMark = 'proposed' | 'removed' | 'rerouted';
export interface SpliceMarks {
  /** By node id. Nodes the splice leaves alone have no mark. */
  nodes: Record<string, NodeMark>;
  /** By `pairKey(from, to)`. */
  edges: Record<string, EdgeMark>;
  /** Per op (same index): the earlier ops it builds on, i.e. whose proposed nodes or relationships it references
   *  or retires (sorted). Deleting op j breaks every op whose `byOp` lists j. */
  byOp: number[][];
  /** Per op (same index): the node ids and pair keys it proposed, retired, restored or changed, and that are still in
   *  the spliced model (and `groups`, when it proposed, renamed or removed one). Empty for a skipped op. */
  touched: { nodes: string[]; edges: string[]; groups?: string[] }[];
  /** Nodes a `replace` swapped out, by id: the node that took over (a removed node here is a replaced one). */
  replaced: Record<string, string>;
  /** Groups the splice proposes or renames, by group id. */
  groups: Record<string, GroupMark>;
  /** Placeholder cards (a proposed group with no card yet: it holds the group's relationships), by node id: their group. */
  placeholders: Record<string, string>;
}
export type GroupMark = 'proposed' | 'renamed';
/** A reference an op made to a node that an earlier op replaced (followed to the replacement) or renamed (named by its
 *  old label): `ref` as written, the node it named, the node it now means. */
export interface SpliceFollow { op: number; ref: string; from: string; to: string; why: 'replaced' | 'renamed' }
/** Per op, when it was an `add` before or after a node: `interpose` (it took over the node's one caller or one callee,
 *  or it had none) or `also` (the node fans out or in, so the new node is a step it also calls, or that also calls it). */
export type SplicePlacement = 'interpose' | 'also';
/** An op that couldn't be applied (it is skipped) or that did nothing. `hint`: a did-you-mean or what to do. */
export interface SpliceWarning { op: number; message: string; hint?: string }
export interface SpliceResult {
  model: Model; marks: SpliceMarks; warnings: SpliceWarning[];
  /** References that followed a replacement or a rename, in op order. */
  follows: SpliceFollow[];
  /** What took each thing out of the what-if, including proposals that are gone from the result: per pair key and per
   *  node id, the (last) op that retired or removed it. For explaining a combination ("disappears because …"). */
  trace: { retired: Record<string, number>; removed: Record<string, number>; placed: Record<number, SplicePlacement> };
}

// ================================================================== small helpers

const KIND_ORDER = new Map(RELATION_KINDS.map((k, i) => [k, i]));
const sortKinds = (ks: Iterable<EdgeKind>) => [...new Set(ks)].filter((k) => KIND_ORDER.has(k)).sort((a, b) => KIND_ORDER.get(a)! - KIND_ORDER.get(b)!);
const NODE_KINDS: readonly NodeKind[] = ['service', 'function', 'store', 'queue', 'external', 'actor'];
/** A kind a proposed node may have: the model's own (not module), or a kit's kind (docs/KITS.md), a lowercase word. */
const isNodeKind = (k: unknown): k is NodeKind => typeof k === 'string' && k !== 'module' && (NODE_KINDS.includes(k as NodeKind) || /^[a-z][a-z0-9-]*$/.test(k));
const isStr = (x: unknown): x is string => typeof x === 'string';
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

/** Lowercase letters and digits only, a leading "the " dropped: how a spoken or typed name is compared. */
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\s*the\s+/, '').replace(/[^a-z0-9]+/g, '');
const words = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\s*the\s+/, '').split(/[^a-z0-9]+/).filter(Boolean);

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const sim = (a: string, b: string) => (a && b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);

/** A slug for ids and file names: lowercase words joined by '-'. */
export function slug(label: string): string {
  const s = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return s || 'node';
}
/** A new node's id: `splice.<slug of label>`, with `-2`, `-3` … until it isn't taken (ids compared as the
 *  model's identity does, so `splice.Cache` and `splice.cache` count as one). */
export function slugId(label: string, taken: Iterable<string> | ((id: string) => boolean) = []): string {
  const isTaken = typeof taken === 'function' ? taken : (() => { const s = new Set([...taken].map(idFold)); return (id: string) => s.has(idFold(id)); })();
  const base = `splice.${slug(label)}`;
  for (let n = 1; ; n++) { const id = n === 1 ? base : `${base}-${n}`; if (!isTaken(id)) return id; }
}
/** A readable name for an id nothing labels: `splice.read-cache` → "read cache". */
const humanize = (id: string) => (id.startsWith('splice.') ? id.slice(7).replace(/-\d+$/, '').replace(/-/g, ' ') : id);
/** Every group id a model knows: its named groups and the ones its nodes name. */
export const groupIds = (m: Model): string[] => [...new Set([...(m.groups ?? []).map((g) => g.id), ...(m.nodes ?? []).map((n) => n.group).filter((g): g is string => !!g)])];
/** The placeholder card of a proposed group with no card yet: `<group id>.entry`. */
export const entryId = (groupId: string) => `${groupId}.entry`;

export interface GroupRefResult { id: string | null; match: 'id' | 'label' | 'none' | 'ambiguous'; suggestions: { id: string; label: string }[] }
/** The group a person means by `ref`: its id, or its label (case, spacing, punctuation and a leading "the" ignored; a
 *  trailing "group" too). Close spellings are only suggested. */
export function resolveGroupRef(model: Pick<Model, 'groups' | 'nodes'>, ref: string): GroupRefResult {
  const named = new Map((model.groups ?? []).map((g) => [g.id, g.label ?? g.id]));
  for (const id of groupIds(model as Model)) if (!named.has(id)) named.set(id, id);
  const all = [...named].map(([id, label]) => ({ id, label }));
  if (!isStr(ref) || !ref.trim()) return { id: null, match: 'none', suggestions: [] };
  if (named.has(ref)) return { id: ref, match: 'id', suggestions: [] };
  const f = fold(ref.replace(/\s+group\s*$/i, ''));
  const byLabel = all.filter((g) => fold(g.label) === f && f);
  if (byLabel.length === 1) return { id: byLabel[0]!.id, match: 'label', suggestions: [] };
  if (byLabel.length > 1) return { id: null, match: 'ambiguous', suggestions: byLabel.slice(0, 3) };
  const byId = all.filter((g) => fold(g.id) === f && f);
  if (byId.length === 1) return { id: byId[0]!.id, match: 'id', suggestions: [] };
  const near = all.map((g) => ({ g, s: Math.max(sim(f, fold(g.label)), sim(f, fold(g.id))) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).map((x) => x.g);
  return { id: null, match: 'none', suggestions: near.slice(0, 3) };
}

// ================================================================== resolving a node reference

export interface NodeRefResult {
  /** The node, or null when the reference isn't one node. */
  id: string | null;
  /** How it matched: the exact id, a label (case, spacing, punctuation and a leading "the" ignored), a close
   *  spelling (only when one node is clearly closest), or nothing / several. */
  match: 'id' | 'label' | 'fuzzy' | 'none' | 'ambiguous';
  /** The closest nodes (best first, at most 3): the did-you-mean. */
  suggestions: { id: string; label: string }[];
}
const nodeList = (m: Model | readonly MNode[]) => (Array.isArray(m) ? (m as readonly MNode[]) : (m as Model).nodes);
/** Find the node a person means by `ref`: an id, a label, or a close spelling of either. Modules (the import
 *  scan's) are never matched: splices change nodes. */
export function resolveNodeRef(model: Model | readonly MNode[], ref: string): NodeRefResult {
  const nodes = nodeList(model).filter((n) => n.kind !== 'module');
  const sug = (ns: MNode[]) => ns.slice(0, 3).map((n) => ({ id: n.id, label: n.label ?? n.id }));
  if (!isStr(ref) || !ref.trim()) return { id: null, match: 'none', suggestions: [] };
  const exact = nodes.find((n) => n.id === ref);
  if (exact) return { id: exact.id, match: 'id', suggestions: [] };
  const f = fold(ref);
  const byLabel = nodes.filter((n) => fold(n.label ?? '') === f && f);
  if (byLabel.length === 1) return { id: byLabel[0]!.id, match: 'label', suggestions: [] };
  if (byLabel.length > 1) return { id: null, match: 'ambiguous', suggestions: sug(byLabel) };
  const byId = nodes.filter((n) => idFold(n.id) === idFold(ref) || fold(n.id) === f);
  if (byId.length === 1) return { id: byId[0]!.id, match: 'id', suggestions: [] };
  if (byId.length > 1) return { id: null, match: 'ambiguous', suggestions: sug(byId) };
  // fuzzy: the closest label, id or last id segment; every word of the ref inside the label counts as close
  const rw = words(ref);
  const scored = nodes.map((n) => {
    const lw = words(n.label ?? ''), last = n.id.split(/[.:/]/).pop() ?? n.id;
    const contained = rw.length > 0 && rw.every((w) => lw.some((x) => x === w || (w.length > 3 && x.startsWith(w))));
    const s = Math.max(sim(f, fold(n.label ?? '')), sim(f, fold(n.id)), sim(f, fold(last)), contained ? 0.85 : 0);
    return { n, s };
  }).filter((x) => x.s >= 0.4).sort((a, b) => b.s - a.s || (a.n.id < b.n.id ? -1 : 1));
  const best = scored[0], second = scored[1];
  if (best && best.s >= 0.75 && (!second || second.s < best.s - 0.1)) return { id: best.n.id, match: 'fuzzy', suggestions: sug(scored.map((x) => x.n)) };
  return { id: null, match: scored.length > 1 && best && second && best.s - second.s < 0.1 && best.s >= 0.75 ? 'ambiguous' : 'none', suggestions: sug(scored.map((x) => x.n)) };
}
const didYouMean = (s: { id: string; label: string }[]) =>
  s.length ? `did you mean ${s.map((x) => (x.label && x.label !== x.id ? `"${x.label}" (${x.id})` : x.id)).join(' or ')}?` : undefined;

// ================================================================== builders

/** Op builders for the UI and Jarvis. `spliceOp.add` always gives the node an id: `opts.id`, else one derived
 *  from the label that isn't in `opts.taken` (a model, or ids). */
export const spliceOp = {
  add(label: string, where: SplicePlace | null = null, opts: Partial<Omit<SpliceNode, 'label'>> & { taken?: Model | Iterable<string> } = {}): SpliceAddOp {
    const { taken, ...node } = opts;
    const ids = taken === undefined ? [] : Array.isArray((taken as Model).nodes) ? (taken as Model).nodes.map((n) => n.id) : (taken as Iterable<string>);
    const n: SpliceNode = { id: node.id ?? slugId(label, ids), label };
    for (const k of ['kind', 'category', 'tags', 'group', 'summary'] as const) if (node[k] !== undefined) (n as any)[k] = node[k];
    return { op: 'add', node: n, ...(where ?? {}) } as SpliceAddOp;
  },
  connect: (from: string, to: string, kind: EdgeKind = 'calls', label?: string): SpliceConnectOp => ({ op: 'connect', from, to, kind, ...(label ? { label } : {}) }),
  disconnect: (from: string, to: string): SpliceDisconnectOp => ({ op: 'disconnect', from, to }),
  remove: (node: string): SpliceRemoveOp => ({ op: 'remove', node }),
  rename: (node: string, label: string): SpliceRenameOp => ({ op: 'rename', node, label }),
  move: (node: string, group: string): SpliceMoveOp => ({ op: 'move', node, group }),
  /** A new group (`label`; `opts.parent` nests it), with its first card and one relationship to a node (`attach`). Its id
   *  is `opts.id`, else one derived from the label that isn't one of `opts.taken`'s groups. */
  group(label: string, opts: { id?: string; parent?: string; summary?: string; first?: string | SpliceNode; attach?: SpliceAttach; taken?: Model | Iterable<string> } = {}): SpliceGroupOp {
    const ids = opts.taken === undefined ? [] : Array.isArray((opts.taken as Model).nodes) ? groupIds(opts.taken as Model) : (opts.taken as Iterable<string>);
    const g: SpliceGroup = { id: opts.id ?? slugId(label, ids), label };
    if (opts.parent) g.parent = opts.parent;
    if (opts.summary) g.summary = opts.summary;
    const first = typeof opts.first === 'string' ? { id: slugId(opts.first, opts.taken !== undefined && Array.isArray((opts.taken as Model).nodes) ? (opts.taken as Model).nodes.map((n) => n.id) : []), label: opts.first } : opts.first;
    return { op: 'group', group: g, ...(first ? { first } : {}), ...(opts.attach ? { attach: opts.attach } : {}) };
  },
  removeGroup: (group: string): SpliceRemoveOp => ({ op: 'remove', group }),
  renameGroup: (group: string, label: string): SpliceRenameOp => ({ op: 'rename', group, label }),
  /** Swap `node` for a new node (`with` a label, and options as for add) or for an existing one (`{ ref }`). */
  replace(node: string, w: string | { ref: string }, opts: Partial<Omit<SpliceNode, 'label'>> & { taken?: Model | Iterable<string> } = {}): SpliceReplaceOp {
    if (typeof w === 'object') return { op: 'replace', node, with: w.ref };
    return { op: 'replace', node, with: spliceOp.add(w, null, opts).node };
  },
};

/** A new splice with no ops. `meta.now` (ISO) fixes the timestamps (tests); the id defaults to a slug of the title. */
export function emptySplice(base: SpliceBase, view: unknown = {}, meta: { id?: string; title?: string; note?: string; now?: string } = {}): Splice {
  const now = meta.now ?? new Date().toISOString();
  const title = meta.title ?? 'Untitled splice';
  return { karyo: SPLICE_FORMAT, id: meta.id ?? slug(title), title, ...(meta.note ? { note: meta.note } : {}), base: { model: base.model, commit: base.commit ?? null, ...(base.scene ? { scene: base.scene } : {}) }, view, created: now, updated: now, ops: [] };
}

// ================================================================== apply

type Place = { kind: 'between'; a: string; b: string } | { kind: 'before'; x: string } | { kind: 'after'; x: string } | { kind: 'attach'; to: string; dir: 'out' | 'in'; ek: EdgeKind } | { kind: 'free' };

/** The working copy of a model while ops apply. */
class Work {
  nodes = new Map<string, MNode>();
  edges = new Map<string, MEdge>(); // relationships by pairKey; imports kept apart, untouched
  imports: MEdge[] = [];
  nmark = new Map<string, NodeMark>();
  emark = new Map<string, EdgeMark>();
  /** Which op proposed a node ('n:id') or relationship ('e:pair'), for `byOp`. */
  origin = new Map<string, number>();
  /** A real relationship rerouted through a proposed node: that node (so removing it restores the relationship). */
  reroutedBy = new Map<string, string>();
  /** A node a replace swapped out: the node that took over (references to it follow). */
  replacedBy = new Map<string, string>();
  /** The label a replaced proposal had (it is gone from `nodes`, but may still be named). */
  replacedLabel = new Map<string, string>();
  /** Labels a node had before an op renamed it (a later op naming it by an old label still finds it). */
  oldLabels = new Map<string, string[]>();
  follows: SpliceFollow[] = [];
  retiredBy = new Map<string, number>();
  removedBy = new Map<string, number>();
  placed: Record<number, SplicePlacement> = {};
  warnings: SpliceWarning[] = [];
  deps: Set<number>[] = [];
  touched: { nodes: Set<string>; edges: Set<string>; groups: Set<string> }[] = [];
  i = 0;
  /** Named groups (labels, nesting), by id; a splice adds the ones it proposes. */
  groups = new Map<string, MGroup>();
  gmark = new Map<string, GroupMark>();
  /** Placeholder cards: a proposed group's stand-in until a card is proposed into it, by node id → its group. */
  ph = new Map<string, string>();
  /** Each node's group in the input (a removed proposed group gives back the real cards moved into it). */
  baseGroup = new Map<string, string | undefined>();
  /** Labels a group had before an op renamed it. */
  oldGroupLabels = new Map<string, string[]>();
  hadGroups: boolean;
  /** The nodes drawn folded into each card (a type's methods): the parts an op naming the card stands for. */
  kids = new Map<string, string[]>();
  card: (id: string) => string;

  constructor(m: Model) {
    for (const n of m.nodes) this.nodes.set(n.id, { ...n, sources: [...(n.sources ?? [])], ...(n.tags ? { tags: [...n.tags] } : {}) });
    for (const e of m.edges) {
      if (isImport(e)) { this.imports.push(e); continue; }
      this.edges.set(pairKey(e.from, e.to), { ...e, sources: [...e.sources], ...(e.kinds ? { kinds: [...e.kinds] } : {}) });
    }
    this.hadGroups = Array.isArray(m.groups);
    for (const g of m.groups ?? []) { this.groups.set(g.id, { ...g, ...(g.sources ? { sources: [...g.sources] } : {}) }); if (isProposed(g)) this.gmark.set(g.id, 'proposed'); }
    for (const n of this.nodes.values()) {
      this.baseGroup.set(n.id, n.group);
      if (isProposed(n)) { this.nmark.set(n.id, 'proposed'); if (n.group && this.gmark.get(n.group) === 'proposed' && n.id === entryId(n.group)) this.ph.set(n.id, n.group); }
    }
    for (const [k, e] of this.edges) if (isProposed(e)) this.emark.set(k, 'proposed');
    this.card = foldRep(m.nodes);
    for (const n of m.nodes) { const c = this.card(n.id); if (c !== n.id) (this.kids.get(c) ?? this.kids.set(c, []).get(c)!).push(n.id); }
  }
  /** A card and the nodes folded into it: what the card stands for on a board. */
  parts(x: string): Set<string> { return new Set([x, ...(this.kids.get(x) ?? [])]); }
  /** The relationships the board's wire a → b stands for: a → b itself, or, when a or b is a card with parts, every one
   *  from a part of a to a part of b. Live ones only, unless `all`. */
  wire(a: string, b: string, all = false): [string, MEdge][] {
    const k = pairKey(a, b);
    const pa = this.parts(a), pb = this.parts(b);
    if ((pa.size === 1 && pb.size === 1) || pa.has(b) || pb.has(a)) { const e = all ? this.edges.get(k) : this.live(k); return e ? [[k, e]] : []; }
    return [...this.edges.entries()].filter(([x, e]) => pa.has(e.from) && pb.has(e.to) && (all || !this.gone(x)));
  }
  /** Live relationships into (dir 'in') or out of a card's parts from outside them: its callers or callees on the board. */
  across(x: string, dir: 'in' | 'out', skip?: string): MEdge[] {
    const p = this.parts(x);
    return this.liveEdges().map(([, e]) => e).filter((e) => (dir === 'in' ? p.has(e.to) && !p.has(e.from) && e.from !== skip : p.has(e.from) && !p.has(e.to) && e.to !== skip));
  }
  /** How many ends those relationships have, as cards (the board's count; a node with no parts counts its own). */
  ends(x: string, es: MEdge[], dir: 'in' | 'out'): number {
    const far = es.map((e) => (dir === 'in' ? e.from : e.to));
    return new Set(this.parts(x).size > 1 ? far.map((f) => this.card(f)) : far).size;
  }
  begin(i: number) { this.i = i; this.deps[i] = new Set(); this.touched[i] = { nodes: new Set(), edges: new Set(), groups: new Set() }; }
  warn(message: string, hint?: string) { this.warnings.push({ op: this.i, message, ...(hint ? { hint } : {}) }); }
  dep(key: string) { const j = this.origin.get(key); if (j !== undefined && j !== this.i) this.deps[this.i]!.add(j); }
  tn(id: string) { this.touched[this.i]!.nodes.add(id); }
  te(k: string) { this.touched[this.i]!.edges.add(k); }
  tg(id: string) { this.touched[this.i]!.groups.add(id); }
  // ---- groups
  glabel(id: string) { return this.groups.get(id)?.label ?? id; }
  /** The group `ref` names (id or label), quietly: null when none or several. */
  gquiet(ref: unknown): string | null {
    if (!nonEmpty(ref)) return null;
    const r = resolveGroupRef({ groups: [...this.groups.values()], nodes: this.liveNodes() }, ref);
    if (r.id) { this.dep(`g:${r.id}`); return r.id; }
    const f = fold(ref);
    const was = [...this.oldGroupLabels].filter(([id, ls]) => this.groups.has(id) && ls.some((l) => fold(l) === f));
    if (was.length === 1) { this.dep(`g:${was[0]![0]}`); return was[0]![0]; }
    return null;
  }
  /** The group `ref` names, or null (warned, with a did-you-mean). */
  gref(ref: unknown, role: string): string | null {
    if (!nonEmpty(ref)) { this.warn(`${role} is missing.`); return null; }
    const g = this.gquiet(ref);
    if (g) return g;
    const r = resolveGroupRef({ groups: [...this.groups.values()], nodes: this.liveNodes() }, ref);
    const dym = r.suggestions.length ? `did you mean ${r.suggestions.map((s) => (s.label !== s.id ? `"${s.label}" (${s.id})` : s.id)).join(' or ')}?` : undefined;
    this.warn(r.match === 'ambiguous' ? `${role} "${ref}" matches several groups.` : `${role} "${ref}" isn't a group in this model.`, dym);
    return null;
  }
  liveNodes() { return [...this.nodes.values()].filter((n) => this.nmark.get(n.id) !== 'removed'); }
  /** Live nodes whose own group is `g`. */
  inGroup(g: string) { return this.liveNodes().filter((n) => n.group === g); }
  /** A group named by `ref` where a node was expected: only an exact id or label, and only when no node has that name. */
  groupInstead(ref: unknown): string | null {
    if (!nonEmpty(ref)) return null;
    const r = resolveNodeRef(this.liveNodes(), ref);
    if (r.id && (r.match === 'id' || r.match === 'label')) return null;
    if ([...this.nodes.keys()].includes(ref)) return null;
    return resolveGroupRef({ groups: [...this.groups.values()], nodes: this.liveNodes() }, ref).id;
  }
  /** The card that stands for a proposed group on a relationship: its placeholder, else its first live card (made a
   *  placeholder when it has none and `make`). Null for a group in the code (which of its cards would it be?). */
  entryOf(g: string, make: boolean): string | null {
    for (const [p, pg] of this.ph) if (pg === g && this.nodes.has(p)) { this.dep(`n:${p}`); return p; }
    if (this.gmark.get(g) !== 'proposed') return null;
    const first = this.inGroup(g)[0];
    if (first) { this.dep(`n:${first.id}`); return first.id; }
    return make ? this.placeholder(g) : null;
  }
  /** A node, or a proposed group (its entry card), for the end of a relationship. */
  endRef(ref: unknown, role: string, make = true): string | null {
    const g = this.groupInstead(ref);
    if (g) {
      const e = this.entryOf(g, make);
      if (e) return e;
      this.warn(`${role} "${String(ref)}" is a group in the code; name one of its cards.`, this.inGroup(g).slice(0, 3).map((n) => n.label ?? n.id).join(', ') || undefined);
      return null;
    }
    return this.ref(ref, role);
  }
  /** A proposed group's placeholder card: it stands for the group (and holds its relationships) until it has a card. */
  placeholder(g: string): string {
    let id = entryId(g);
    for (let n = 2; this.nodes.has(id); n++) id = `${entryId(g)}-${n}`;
    this.nodes.set(id, { id, kind: 'service', label: `${this.glabel(g)} (no cards yet)`, group: g, sources: ['proposed'] });
    this.nmark.set(id, 'proposed');
    this.ph.set(id, g);
    this.origin.set(`n:${id}`, this.i);
    this.tn(id);
    return id;
  }
  /** A card landed in group g: it takes over the group's placeholder (its relationships), which goes. */
  takeOver(id: string, g: string | undefined) {
    if (!g) return;
    const p = [...this.ph].find(([x, pg]) => pg === g && x !== id && this.nodes.has(x))?.[0];
    if (!p) return;
    this.dep(`n:${p}`);
    for (const [k, e] of [...this.edges]) {
      if (e.from !== p && e.to !== p) continue;
      const f = e.from === p ? id : e.from, t = e.to === p ? id : e.to;
      if (!this.gone(k) && f !== t) this.propose(f, t, kindsOf(e), e.label);
      this.retire(k, 'removed');
    }
    this.nodes.delete(p); this.nmark.delete(p); this.ph.delete(p);
  }
  /** A proposed group left with no live card gets its placeholder back (an entered group is never just empty). */
  refill(g: string | undefined) {
    if (!g || this.gmark.get(g) !== 'proposed' || !this.groups.has(g)) return;
    if (this.inGroup(g).length) return;
    this.placeholder(g);
  }
  label(id: string) { return this.nodes.get(id)?.label ?? this.replacedLabel.get(id) ?? humanize(id); }
  gone(k: string) { const m = this.emark.get(k); return m === 'removed' || m === 'rerouted'; }
  /** A relationship the what-if still has. */
  live(k: string) { const e = this.edges.get(k); return e && !this.gone(k) ? e : undefined; }
  liveEdges() { return [...this.edges.entries()].filter(([k]) => !this.gone(k)); }
  /** Where a replaced node's references go now: the end of its chain of replacements, if that is still in the what-if. */
  through(x: string): string | null {
    let y = x;
    for (let n = 0; n < 32 && this.replacedBy.has(y); n++) y = this.replacedBy.get(y)!;
    return y !== x && this.nodes.has(y) && this.nmark.get(y) !== 'removed' ? y : null;
  }

  /** `ref` as a node of the what-if, or null (warned, with a did-you-mean). `follow`: a node an earlier op replaced
   *  means its replacement (placements, connect, disconnect); a remove, rename, move or replace of it doesn't follow. */
  ref(ref: unknown, role: string, follow = true): string | null {
    if (!nonEmpty(ref)) { this.warn(`${role} is missing.`); return null; }
    const live = [...this.nodes.values()].filter((n) => this.nmark.get(n.id) !== 'removed');
    const r = resolveNodeRef(live, ref);
    if (r.id && (r.match === 'id' || r.match === 'label')) { this.dep(`n:${r.id}`); return r.id; }
    // a node an earlier op removed or replaced (by its id or its label)
    const f = fold(ref);
    const gone = this.nmark.get(ref) === 'removed' || this.replacedBy.has(ref) ? ref
      : [...this.nmark].find(([id, mk]) => mk === 'removed' && fold(this.nodes.get(id)?.label ?? '') === f)?.[0]
      ?? [...this.replacedLabel].find(([, l]) => fold(l) === f)?.[0];
    if (gone) {
      const y = follow ? this.through(gone) : null;
      if (y) { this.follows.push({ op: this.i, ref, from: gone, to: y, why: 'replaced' }); this.dep(`n:${y}`); return y; }
      const by = this.replacedBy.get(gone);
      if (by) this.warn(`${role} "${ref}" is replaced by ${this.label(by)} (an earlier op).`, `refer to ${this.label(by)} instead`);
      else this.warn(`${role} "${ref}" is removed by an earlier op.`, 'drop the remove, or refer to another node');
      return null;
    }
    // a node an earlier op renamed, named by its old label
    const was = [...this.oldLabels].filter(([id, ls]) => this.nodes.has(id) && this.nmark.get(id) !== 'removed' && ls.some((l) => fold(l) === f));
    if (was.length === 1) { const id = was[0]![0]; this.follows.push({ op: this.i, ref, from: id, to: id, why: 'renamed' }); this.dep(`n:${id}`); return id; }
    const mod = this.nodes.get(ref);
    if (mod?.kind === 'module') { this.warn(`${role} "${ref}" is a module from the import scan, not a node.`, didYouMean(r.suggestions) ?? 'name a node'); return null; }
    if (r.match === 'ambiguous') { this.warn(`${role} "${ref}" matches several nodes.`, didYouMean(r.suggestions) ? `use an id: ${didYouMean(r.suggestions)}` : undefined); return null; }
    this.warn(`${role} "${ref}" isn't a node in this model.`, didYouMean(r.suggestions));
    return null;
  }

  /** Add (or widen) a proposed relationship; a real one the splice had retired is restored instead. */
  propose(from: string, to: string, kinds: EdgeKind[], label?: string): 'added' | 'restored' | 'exists' {
    if (from === to) return 'exists';
    const k = pairKey(from, to);
    const cur = this.edges.get(k);
    this.te(k);
    if (cur && !isProposed(cur)) {
      if (!this.gone(k)) return 'exists';
      this.emark.delete(k); this.reroutedBy.delete(k);
      return 'restored';
    }
    const ks = sortKinds([...(cur ? kindsOf(cur) : []), ...kinds]);
    const all = ks.length ? ks : (['calls'] as EdgeKind[]);
    const labels = new Set([...(cur?.label ? [cur.label] : []), ...(label ? [label] : [])]);
    this.edges.set(k, { from, to, kind: all[0]!, ...(all.length > 1 ? { kinds: all } : {}), ...(labels.size ? { label: [...labels].join(' · ') } : {}), sources: ['proposed'] });
    this.emark.set(k, 'proposed');
    if (cur && this.origin.has(`e:${k}`)) this.dep(`e:${k}`); else this.origin.set(`e:${k}`, this.i);
    return 'added';
  }
  /** Take a relationship out of the what-if: a proposed one is deleted (it never existed), a real one is kept
   *  and marked (a ghost). */
  retire(k: string, why: 'removed' | 'rerouted', by?: string) {
    const e = this.edges.get(k);
    if (!e) return;
    this.te(k);
    if (isProposed(e)) { this.dep(`e:${k}`); this.edges.delete(k); this.emark.delete(k); this.retiredBy.set(k, this.i); return; }
    if (this.gone(k)) return;
    this.emark.set(k, why);
    this.retiredBy.set(k, this.i);
    if (by) this.reroutedBy.set(k, by);
  }

  /** A new proposed node from `nd` (its id given or derived from the label; kind, category and group from `dflt` when
   *  it has none): its id, or null (warned). */
  newNode(nd: SpliceNode, label: string, what: string, dflt: { kind?: NodeKind; category?: string; group?: string }): string | null {
    let id: string;
    if (nd.id !== undefined) {
      if (!isStr(nd.id) || !ID_RE.test(nd.id)) { this.warn(`${what} "${label}": id ${JSON.stringify(nd.id)} isn't a valid node id.`, `e.g. ${slugId(label, (x) => this.nodes.has(x))}`); return null; }
      const clash = [...this.nodes.keys()].find((x) => x !== nd.id && idFold(x) === idFold(nd.id!));
      if (clash) { this.warn(`${what} "${label}": id ${nd.id} is ${clash} spelled differently.`, `use another id, e.g. ${slugId(label, (x) => this.nodes.has(x) || idFold(x) === idFold(nd.id!))}`); return null; }
      if (this.nodes.has(nd.id)) { this.warn(`${what} "${label}": ${nd.id} is already a node${isProposed(this.nodes.get(nd.id)!) ? ' this splice adds' : ''}.`, `use another id, e.g. ${slugId(label, (x) => this.nodes.has(x))}`); return null; }
      id = nd.id;
    } else id = slugId(label, (x) => [...this.nodes.keys()].some((y) => idFold(y) === idFold(x)) || this.replacedBy.has(x));
    let kind: NodeKind = dflt.kind && dflt.kind !== 'module' ? dflt.kind : 'service';
    if (nd.kind !== undefined) {
      if (isNodeKind(nd.kind)) kind = nd.kind;
      else this.warn(`${what} "${label}": kind "${String(nd.kind)}" isn't a node kind; drawn as a ${kind}.`, `use one of ${NODE_KINDS.join(', ')}, or a kit's kind (a lowercase word)`);
    }
    // a group named by its id or label (a proposed one included); a name no group has is a new group id, as before
    const group = nonEmpty(nd.group) ? this.gquiet(nd.group) ?? nd.group : dflt.group || 'splice';
    const tags = Array.isArray(nd.tags) ? [...new Set(nd.tags.filter(nonEmpty))].sort() : [];
    const category = nonEmpty(nd.category) ? nd.category : dflt.category;
    const node: MNode = { id, kind, label, ...(nonEmpty(nd.summary) ? { summary: nd.summary } : {}), group, ...(nonEmpty(category) ? { category } : {}), ...(tags.length ? { tags } : {}), sources: ['proposed'] };
    this.nodes.set(id, node);
    this.nmark.set(id, 'proposed');
    this.origin.set(`n:${id}`, this.i);
    this.tn(id);
    // the first card proposed into a group that has none takes over its placeholder
    this.takeOver(id, group);
    return id;
  }

  add(op: SpliceAddOp) {
    const nd = (op.node ?? {}) as SpliceNode;
    if (!nd || typeof nd !== 'object') return this.warn('add has no node.', 'give it { "node": { "label": "…" } }');
    const label = nonEmpty(nd.label) ? nd.label.trim() : nonEmpty(nd.id) ? humanize(nd.id) : '';
    if (!label) return this.warn('add needs a node label (or an id).', 'give it { "node": { "label": "…" } }');
    // combining splices: a node another splice already proposed, placed here too (the two are "the same")
    const reuse = (op as { $reuse?: boolean }).$reuse === true && isStr(nd.id) && this.nodes.has(nd.id) ? nd.id : null;
    // placement: at most one
    const keys = (['between', 'before', 'after', 'attach'] as const).filter((k) => (op as any)[k] !== undefined && (op as any)[k] !== null);
    if (keys.length > 1) return this.warn(`add "${label}" has ${keys.join(' and ')}; it can go only one place.`, `keep one of ${keys.join(', ')}`);
    let place: Place = { kind: 'free' };
    let rel: MEdge | undefined;
    let under: [string, MEdge][] = [];
    if (keys[0] === 'between') {
      const bw = op.between;
      if (!Array.isArray(bw) || bw.length !== 2) return this.warn(`add "${label}": between needs two nodes.`, 'e.g. "between": ["a", "b"]');
      const a = this.ref(bw[0], 'between[0]'); if (!a) return;
      const b = this.ref(bw[1], 'between[1]'); if (!b) return;
      if (a === b) return this.warn(`add "${label}": between names ${this.label(a)} twice.`);
      // the wire a → b (or b → a) as the board draws it: between two cards with parts, every relationship of their parts
      const fw = this.wire(a, b);
      under = fw.length ? fw : this.wire(b, a);
      rel = under[0]?.[1];
      if (!rel) {
        const was = this.wire(a, b, true).length || this.wire(b, a, true).length;
        if (was) return this.warn(`add "${label}": ${this.label(a)} and ${this.label(b)} are no longer connected (an earlier op retired it).`);
        const near = this.liveEdges().map(([, e]) => e).filter((e) => e.from === a || e.to === a).map((e) => (e.from === a ? e.to : e.from));
        const alt = resolveNodeRef(near.map((id) => this.nodes.get(id)!).filter(Boolean), bw[1] as string);
        return this.warn(`add "${label}": there is no relationship between ${this.label(a)} and ${this.label(b)} to insert into.`,
          alt.suggestions.length ? `${this.label(a)} is connected to ${alt.suggestions.map((s) => `"${s.label}" (${s.id})`).join(', ')}; or use "attach"` : 'use "connect", or "attach" the new node');
      }
      place = fw.length ? { kind: 'between', a, b } : { kind: 'between', a: b, b: a };
    } else if (keys[0] === 'before' || keys[0] === 'after') {
      const x = this.ref((op as any)[keys[0]], keys[0]); if (!x) return;
      place = { kind: keys[0], x };
    } else if (keys[0] === 'attach') {
      const at = op.attach as SpliceAttach;
      if (!at || typeof at !== 'object') return this.warn(`add "${label}": attach needs { "to": … }.`);
      const to = this.endRef(at.to, 'attach.to'); if (!to) return;
      const dir = at.dir ?? 'out';
      if (dir !== 'out' && dir !== 'in') return this.warn(`add "${label}": attach.dir is "${String(dir)}".`, 'use "out" (new → to) or "in" (to → new)');
      const ek = at.kind ?? 'calls';
      if (!KIND_ORDER.has(ek)) return this.warn(`add "${label}": attach.kind "${String(ek)}" isn't a relationship kind.`, `use one of ${RELATION_KINDS.join(', ')}`);
      place = { kind: 'attach', to, dir, ek };
    }
    // next to a placeholder (a proposed group with no card yet): the new card goes into that group and takes it over
    const ends = place.kind === 'between' ? [place.a, place.b] : place.kind === 'before' || place.kind === 'after' ? [place.x] : place.kind === 'attach' ? [place.to] : [];
    const intoGroup = ends.map((x) => this.ph.get(x)).find((g) => !!g);
    if (intoGroup) place = { kind: 'free' };
    // the node: new (its id given or derived from the label), or the one another splice proposed
    const near = place.kind === 'between' ? place.b : place.kind === 'before' || place.kind === 'after' ? place.x : place.kind === 'attach' ? place.to : undefined;
    const id = reuse ?? this.newNode(intoGroup && !nonEmpty(nd.group) ? { ...nd, group: intoGroup } : nd, label, 'add', { group: (near && this.nodes.get(near)?.group) || undefined });
    if (!id) return;
    if (reuse) { this.tn(id); this.dep(`n:${id}`); }
    // its relationships
    if (place.kind === 'between') {
      const ks = sortKinds(under.flatMap(([, e]) => kindsOf(e)));
      this.propose(place.a, id, ks);
      this.propose(id, place.b, ks);
      for (const [k] of under) this.retire(k, 'rerouted', id);
    } else if (place.kind === 'before') {
      // one caller (or none): the new node goes in front of X; several: it is one more step that calls X
      const callers = this.across(place.x, 'in', id);
      if (this.ends(place.x, callers, 'in') > 1) { this.placed[this.i] = 'also'; this.propose(id, place.x, ['calls']); }
      else {
        this.placed[this.i] = 'interpose';
        for (const e of callers) { this.propose(e.from, id, kindsOf(e)); this.retire(pairKey(e.from, e.to), 'rerouted', id); }
        this.propose(id, place.x, sortKinds(callers.flatMap(kindsOf)));
      }
    } else if (place.kind === 'after') {
      // one callee (or none): the new node goes behind X; several (X fans out): it is one more step X calls
      const outs = this.across(place.x, 'out', id);
      if (this.ends(place.x, outs, 'out') > 1) { this.placed[this.i] = 'also'; this.propose(place.x, id, ['calls']); }
      else {
        this.placed[this.i] = 'interpose';
        for (const e of outs) { this.propose(id, e.to, kindsOf(e)); this.retire(pairKey(e.from, e.to), 'rerouted', id); }
        this.propose(place.x, id, sortKinds(outs.flatMap(kindsOf)));
      }
    } else if (place.kind === 'attach') {
      if (place.dir === 'out') this.propose(id, place.to, [place.ek]); else this.propose(place.to, id, [place.ek]);
    }
  }

  connect(op: SpliceConnectOp) {
    const kind = op.kind ?? 'calls';
    if (!KIND_ORDER.has(kind)) return this.warn(`connect: kind "${String(kind)}" isn't a relationship kind.`, `use one of ${RELATION_KINDS.join(', ')}`);
    const a = this.endRef(op.from, 'from'); if (!a) return;
    const b = this.endRef(op.to, 'to'); if (!b) return;
    if (a === b) return this.warn(`connect: ${this.label(a)} to itself.`);
    // two cards whose parts are related already have that wire on the board
    if (!this.edges.has(pairKey(a, b)) && (this.parts(a).size > 1 || this.parts(b).size > 1) && this.wire(a, b).length)
      return this.warn(`connect: ${this.label(a)} → ${this.label(b)} is already a relationship (through ${this.wire(a, b).map(([, e]) => `${this.label(e.from)} → ${this.label(e.to)}`).slice(0, 2).join(', ')}); nothing to add.`);
    const r = this.propose(a, b, [kind], nonEmpty(op.label) ? op.label : undefined);
    if (r === 'exists') this.warn(`connect: ${this.label(a)} → ${this.label(b)} is already a relationship; nothing to add.`);
  }
  disconnect(op: SpliceDisconnectOp) {
    const a = this.endRef(op.from, 'from', false); if (!a) return;
    const b = this.endRef(op.to, 'to', false); if (!b) return;
    const k = pairKey(a, b);
    if (this.live(k)) { this.dep(`e:${k}`); return this.retire(k, 'removed'); }
    const under = this.wire(a, b);                // cards with parts: every relationship between them
    if (under.length) { for (const [x] of under) { this.dep(`e:${x}`); this.retire(x, 'removed'); } return; }
    if (this.edges.has(k) || this.wire(a, b, true).length) return this.warn(`disconnect: ${this.label(a)} → ${this.label(b)} is already gone (an earlier op).`);
    this.warn(`disconnect: there is no relationship ${this.label(a)} → ${this.label(b)}.`, this.live(pairKey(b, a)) ? `did you mean ${this.label(b)} → ${this.label(a)} (from "${b}" to "${a}")?` : undefined);
  }
  remove(op: SpliceRemoveOp) {
    const g = op.group !== undefined ? op.group : this.groupInstead(op.node);
    if (op.group !== undefined || g) return this.removeGroup(g, op.group !== undefined);
    const x = this.ref(op.node, 'node', false); if (!x) return;
    const from = this.nodes.get(x)!.group;
    const parts = this.parts(x);
    this.removeNode(x);
    // a card goes with what is folded into it (a type's methods)
    for (const p of parts) if (p !== x && this.nodes.has(p) && this.nmark.get(p) !== 'removed') this.removeNode(p);
    this.refill(from);
  }
  removeNode(x: string) {
    const n = this.nodes.get(x)!;
    this.tn(x);
    this.removedBy.set(x, this.i);
    if (isProposed(n)) {
      // it never existed: take it out, with its relationships, and give back what it had rerouted (or replaced)
      this.dep(`n:${x}`);
      for (const [k, e] of [...this.edges]) if (e.from === x || e.to === x) this.retire(k, 'removed');
      for (const [k, by] of [...this.reroutedBy]) if (by === x) { this.reroutedBy.delete(k); this.emark.delete(k); this.te(k); }
      for (const [was, by] of [...this.replacedBy]) if (by === x) { this.replacedBy.delete(was); if (this.nodes.has(was) && this.nmark.get(was) === 'removed') { this.nmark.delete(was); this.tn(was); } }
      this.nodes.delete(x); this.nmark.delete(x); this.ph.delete(x);
      return;
    }
    this.nmark.set(x, 'removed');
    for (const [k, e] of [...this.edges]) if ((e.from === x || e.to === x) && !this.gone(k)) this.retire(k, 'removed');
  }
  /** Remove a group this splice proposes: its proposed cards and subgroups go (they never existed); a card in the code
   *  that was moved into it goes back to its own group. */
  removeGroup(ref: unknown, named: boolean) {
    const g = named ? this.gref(ref, 'group') : (ref as string);
    if (!g) return;
    if (this.gmark.get(g) !== 'proposed') return this.warn(`remove: ${this.glabel(g)} is a group in the code; only a group this splice proposes can be removed.`, 'remove its cards instead');
    this.dep(`g:${g}`);
    const sub = [...this.groups.values()].filter((x) => { for (let p: string | undefined = x.id, k = 0; p && k < 32; p = this.groups.get(p)?.parent, k++) if (p === g) return true; return false; }).map((x) => x.id);
    for (const x of [...this.nodes.values()].filter((n) => n.group && sub.includes(n.group))) {
      if (isProposed(x)) { this.removeNode(x.id); continue; }
      const back = this.baseGroup.get(x.id);
      if (back === undefined) delete x.group; else x.group = back;
      if (this.nmark.get(x.id) === 'moved') this.nmark.delete(x.id);
      this.tn(x.id);
    }
    for (const x of sub) { this.groups.delete(x); this.gmark.delete(x); this.tg(x); }
  }  replace(op: SpliceReplaceOp) {
    const x = this.ref(op.node, 'node', false); if (!x) return;
    const xn = this.nodes.get(x)!;
    const w = op.with as unknown;
    let y: string | null;
    if (isStr(w)) {
      y = this.ref(w, 'with'); if (!y) return;
      if (y === x) return this.warn(`replace: ${this.label(x)} with itself.`);
    } else if (w && typeof w === 'object' && !Array.isArray(w)) {
      const nd = w as SpliceNode;
      const label = nonEmpty(nd.label) ? nd.label.trim() : nonEmpty(nd.id) ? humanize(nd.id) : '';
      if (!label) return this.warn(`replace ${this.label(x)}: the new node needs a label (or an id).`, 'give it { "with": { "label": "…" } }');
      y = this.newNode(nd, label, 'replace', { kind: xn.kind, category: xn.category, group: xn.group });
      if (!y) return;
    } else return this.warn(`replace ${this.label(x)}: "with" is missing.`, 'give it "with": { "label": "…" } (a new node) or "with": "<node>" (one that exists)');
    // Y takes over every relationship of X, in and out (X's old ones are rerouted through Y); a card's include its parts'
    const px = this.parts(x);
    for (const [k, e] of this.liveEdges()) {
      if (!px.has(e.from) && !px.has(e.to)) continue;
      const f = px.has(e.from) ? y : e.from, t = px.has(e.to) ? y : e.to;
      if (f !== t) this.propose(f, t, kindsOf(e), e.label);
      this.retire(k, 'rerouted', y);
    }
    for (const [k, by] of [...this.reroutedBy]) if (by === x) this.reroutedBy.set(k, y);
    this.tn(y);
    this.removedBy.set(x, this.i);
    this.replacedBy.set(x, y);
    if (isProposed(xn)) { this.dep(`n:${x}`); this.replacedLabel.set(x, xn.label ?? humanize(x)); this.nodes.delete(x); this.nmark.delete(x); }
    else { this.nmark.set(x, 'removed'); this.tn(x); }
    for (const p of px) if (p !== x && this.nodes.has(p) && this.nmark.get(p) !== 'removed') { this.nmark.set(p, 'removed'); this.tn(p); }
  }
  rename(op: SpliceRenameOp) {
    if (!nonEmpty(op.label)) return this.warn('rename needs a new label.');
    const g = op.group !== undefined ? this.gref(op.group, 'group') : this.groupInstead(op.node);
    if (op.group !== undefined && !g) return;
    if (g) return this.renameGroup(g, op.label.trim());
    const x = this.ref(op.node, 'node', false); if (!x) return;
    const n = this.nodes.get(x)!;
    if (n.label === op.label.trim()) return this.warn(`rename: ${x} is already called "${n.label}".`);
    if (n.label) this.oldLabels.set(x, [...(this.oldLabels.get(x) ?? []), n.label]);
    n.label = op.label.trim();
    if (!isProposed(n) && this.nmark.get(x) !== 'removed') this.nmark.set(x, 'renamed');
    this.tn(x);
  }
  renameGroup(g: string, label: string) {
    const cur = this.groups.get(g);
    const was = cur?.label ?? g;
    if (was === label) return this.warn(`rename: the group ${g} is already called "${label}".`);
    this.oldGroupLabels.set(g, [...(this.oldGroupLabels.get(g) ?? []), was]);
    this.groups.set(g, { ...(cur ?? { id: g }), label });
    if (this.gmark.get(g) !== 'proposed') this.gmark.set(g, 'renamed');
    // a placeholder says its group's name
    for (const [p, pg] of this.ph) if (pg === g && this.nodes.has(p)) { this.nodes.get(p)!.label = `${label} (no cards yet)`; this.tn(p); }
    this.tg(g);
  }
  move(op: SpliceMoveOp) {
    if (!nonEmpty(op.group)) return this.warn('move needs a group.');
    const x = this.ref(op.node, 'node', false); if (!x) return;
    const n = this.nodes.get(x)!;
    const g = this.gquiet(op.group) ?? op.group;
    if (n.group === g) return this.warn(`move: ${this.label(x)} is already in ${this.glabel(g)}.`);
    const from = n.group;
    n.group = g;
    if (!isProposed(n) && this.nmark.get(x) !== 'removed') this.nmark.set(x, 'moved');
    this.tn(x);
    this.takeOver(x, g);
    this.refill(from);
  }
  group(op: SpliceGroupOp) {
    const gd = op.group as SpliceGroup | undefined;
    if (!gd || typeof gd !== 'object') return this.warn('group has no group.', 'give it { "group": { "label": "…" } }');
    const label = nonEmpty(gd.label) ? gd.label.trim() : nonEmpty(gd.id) ? humanize(gd.id) : '';
    if (!label) return this.warn('group needs a label (or an id).', 'give it { "group": { "label": "…" } }');
    // combining splices: a group another splice already proposed, used here too (the two are "the same")
    const reuse = (op as { $reuse?: boolean }).$reuse === true && isStr(gd.id) && this.groups.has(gd.id) ? gd.id : null;
    let parent: string | null = null;
    if (!reuse && gd.parent !== undefined && gd.parent !== null && gd.parent !== '') { parent = this.gref(gd.parent, 'group.parent'); if (!parent) return; }
    // the relationship first
    let att: { to: string; dir: 'out' | 'in'; ek: EdgeKind } | null = null;
    if (op.attach !== undefined && op.attach !== null) {
      const at = op.attach as SpliceAttach;
      if (!at || typeof at !== 'object') return this.warn(`group "${label}": attach needs { "to": … }.`);
      const dir = at.dir ?? 'out';
      if (dir !== 'out' && dir !== 'in') return this.warn(`group "${label}": attach.dir is "${String(dir)}".`, 'use "in" (to → the group: an outlet of it) or "out" (the group → to)');
      const ek = at.kind ?? 'calls';
      if (!KIND_ORDER.has(ek)) return this.warn(`group "${label}": attach.kind "${String(ek)}" isn't a relationship kind.`, `use one of ${RELATION_KINDS.join(', ')}`);
      // (a node that isn't there: the group is still proposed, without the relationship, and says so)
      const to = this.endRef(at.to, 'attach.to');
      if (to) att = { to, dir, ek };
    }
    let gid: string;
    if (reuse) gid = reuse;
    else {
      const all = resolveGroupRef({ groups: [...this.groups.values()], nodes: this.liveNodes() }, label);
      if (all.id && all.match === 'label') return this.warn(`group "${label}": there is already a group called ${this.glabel(all.id)}.`, `put cards in it ("group": "${all.id}")`);
      const taken = (x: string) => this.groups.has(x) || [...this.nodes.values()].some((n) => n.group === x);
      if (gd.id !== undefined) {
        if (!isStr(gd.id) || !ID_RE.test(gd.id)) return this.warn(`group "${label}": id ${JSON.stringify(gd.id)} isn't a valid id.`, `e.g. ${slugId(label, taken)}`);
        if (taken(gd.id)) return this.warn(`group "${label}": ${gd.id} is already a group.`, `use another id, e.g. ${slugId(label, taken)}`);
        gid = gd.id;
      } else gid = slugId(label, taken);
    }
    // its first card, or a placeholder that holds the relationship until it has one
    let entry: string | null = null;
    if (op.first !== undefined && op.first !== null) {
      const fd = op.first as SpliceNode;
      const fl = fd && typeof fd === 'object' && nonEmpty(fd.label) ? fd.label.trim() : fd && typeof fd === 'object' && nonEmpty(fd.id) ? humanize(fd.id) : '';
      if (!fl) return this.warn(`group "${label}": its first card needs a label.`, 'give it "first": { "label": "…" }');
      if (!reuse) this.addGroup(gid, label, parent, gd.summary);
      entry = this.newNode({ ...fd, group: gid }, fl, `group "${label}": first card`, { group: gid });
      if (!entry) { if (!reuse) { this.groups.delete(gid); this.gmark.delete(gid); this.touched[this.i]!.groups.delete(gid); } return; }
    } else if (!reuse) { this.addGroup(gid, label, parent, gd.summary); entry = this.placeholder(gid); }
    else { this.tg(gid); this.dep(`g:${gid}`); entry = att ? this.entryOf(gid, true) : null; }
    if (att && entry) { if (att.dir === 'out') this.propose(entry, att.to, [att.ek]); else this.propose(att.to, entry, [att.ek]); }
  }
  addGroup(id: string, label: string, parent: string | null, summary?: string) {
    this.groups.set(id, { id, label, ...(parent ? { parent } : {}), ...(nonEmpty(summary) ? { summary } : {}), sources: ['proposed'] });
    this.gmark.set(id, 'proposed');
    this.origin.set(`g:${id}`, this.i);
    this.tg(id);
  }

  run(ops: readonly unknown[], skip?: ReadonlySet<number>) {
    ops.forEach((raw, i) => {
      this.begin(i);
      if (skip?.has(i)) return;
      const op = raw as SpliceOp;
      if (!op || typeof op !== 'object' || !SPLICE_OPS.includes((op as any).op)) {
        this.warn(`op ${i + 1} isn't an op${op && typeof op === 'object' && 'op' in op ? ` ("${String((op as any).op)}")` : ''}.`, `use one of ${SPLICE_OPS.join(', ')}`);
        return;
      }
      this[op.op](op as never);
    });
  }
  result(base: Model): SpliceResult {
    return {
      model: { ...base, nodes: [...this.nodes.values()], edges: [...this.edges.values(), ...this.imports], ...(this.hadGroups || this.groups.size ? { groups: [...this.groups.values()] } : {}) },
      marks: {
        nodes: Object.fromEntries(this.nmark),
        edges: Object.fromEntries(this.emark),
        byOp: this.deps.map((d) => [...(d ?? [])].sort((a, b) => a - b)),
        // what is still there to point at (a proposed relationship an op took back again is gone)
        touched: this.touched.map((t) => {
          const groups = [...(t?.groups ?? [])].filter((g) => this.groups.has(g));
          return { nodes: [...(t?.nodes ?? [])].filter((id) => this.nodes.has(id)), edges: [...(t?.edges ?? [])].filter((k) => this.edges.has(k)), ...(groups.length ? { groups } : {}) };
        }),
        replaced: Object.fromEntries([...this.replacedBy].filter(([x]) => this.nodes.has(x))),
        groups: Object.fromEntries([...this.gmark].filter(([g]) => this.groups.has(g))),
        placeholders: Object.fromEntries([...this.ph].filter(([x]) => this.nodes.has(x))),
      },
      warnings: this.warnings,
      follows: this.follows,
      trace: { retired: Object.fromEntries(this.retiredBy), removed: Object.fromEntries(this.removedBy), placed: { ...this.placed } },
    };
  }
}

/** The marks a structure board draws with. The board folds parts into their cards (a type's methods into the type,
 *  `foldView`), so one wire there can stand for several relationships of the model, and the marks (keyed by the
 *  model's relationships) don't name it. This adds a mark for each such folded wire when everything it stands for has
 *  one: proposed, or retired (rerouted when any of them was, else removed). Relationships of the model keep theirs. */
export function boardMarks(r: SpliceResult): SpliceMarks {
  const card = foldRep(r.model.nodes);
  const own = new Set(r.model.edges.filter((e) => !isImport(e)).map((e) => pairKey(e.from, e.to)));
  const folded = new Map<string, (EdgeMark | undefined)[]>();
  for (const e of r.model.edges) {
    if (isImport(e)) continue;
    const a = card(e.from), b = card(e.to);
    if (a === b || (a === e.from && b === e.to)) continue;
    const k = pairKey(a, b);
    if (own.has(k)) continue;
    (folded.get(k) ?? folded.set(k, []).get(k)!).push(r.marks.edges[pairKey(e.from, e.to)]);
  }
  if (!folded.size) return r.marks;
  const edges: Record<string, EdgeMark> = { ...r.marks.edges };
  for (const [k, ms] of folded) {
    if (ms.every((m) => m === 'proposed')) edges[k] = 'proposed';
    else if (ms.every((m) => m === 'removed' || m === 'rerouted')) edges[k] = ms.includes('rerouted') ? 'rerouted' : 'removed';
  }
  return { ...r.marks, edges };
}

/** The model as the splice proposes it: a new model (the input is never touched) with proposed nodes and
 *  relationships (`sources: ['proposed']`) and every real one kept, plus marks saying what the splice does to
 *  each. Ops apply in order; later ops may name nodes earlier ops added. An op that can't apply (an unknown
 *  node, no relationship to insert into) is skipped with a warning; this never throws. Applying the same
 *  splice to its own result changes nothing. */
export function applySplice(model: Model, splice: Splice): SpliceResult {
  const base = withoutOwn(normalize({ ...model, nodes: model.nodes ?? [], edges: model.edges ?? [], flows: model.flows ?? [] }), Array.isArray(splice?.ops) ? splice.ops : []);
  const w = new Work(base);
  w.run(Array.isArray(splice?.ops) ? splice.ops : []);
  if (!Array.isArray(splice?.ops)) w.warnings.push({ op: -1, message: 'the splice has no ops list.' });
  return w.result(base);
}

/** A model this splice was already applied to (its proposed nodes and relationships are in it): without them,
 *  so applying again proposes them afresh, in order, and the result is the same. Proposed items another
 *  splice put there stay (splices stack). */
function withoutOwn(m: Model, ops: readonly SpliceOp[]): Model {
  if (!m.nodes.some(isProposed) && !m.edges.some(isProposed) && !(m.groups ?? []).some(isProposed)) return m;
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const own = new Set<string>(), reserved = new Set<string>();
  // the groups it proposes (and their placeholders and first cards)
  const gById = new Map((m.groups ?? []).map((g) => [g.id, g]));
  const ownG = new Set<string>(), reservedG = new Set<string>();
  const firsts: SpliceNode[] = [];
  for (const op of ops) {
    if (op?.op !== 'group' || !op.group || typeof op.group !== 'object') continue;
    const label = nonEmpty(op.group.label) ? op.group.label.trim() : '';
    let id: string | null = isStr(op.group.id) ? op.group.id : null;
    const usedBy = (x: string) => gById.has(x) || m.nodes.some((n) => n.group === x);
    if (id === null && label) id = slugId(label, (x) => reservedG.has(x) || (usedBy(x) && !(gById.has(x) && isProposed(gById.get(x)!) && fold(gById.get(x)!.label ?? '') === fold(label))));
    if (id === null) continue;
    reservedG.add(id);
    if (gById.has(id) && isProposed(gById.get(id)!)) { ownG.add(id); if (byId.has(entryId(id)) && isProposed(byId.get(entryId(id))!)) own.add(entryId(id)); }
    if (op.first && typeof op.first === 'object') firsts.push(op.first);
  }
  for (const nd of [...ops.map((op) => (op?.op === 'add' ? op.node : op?.op === 'replace' ? op.with : null)), ...firsts]) {
    if (!nd || typeof nd !== 'object') continue;
    const label = nonEmpty(nd.label) ? nd.label.trim() : '';
    let id: string | null = isStr(nd.id) ? nd.id : null;
    if (id === null && label) id = slugId(label, (x) => reserved.has(x) || (byId.has(x) && !(isProposed(byId.get(x)!) && fold(byId.get(x)!.label ?? '') === fold(label))));
    if (id === null) continue;
    reserved.add(id);
    if (byId.has(id) && isProposed(byId.get(id)!)) own.add(id);
  }
  const pairs = new Set<string>();
  for (const op of ops) if (op?.op === 'connect') {
    const a = resolveNodeRef(m, op.from), b = resolveNodeRef(m, op.to);
    if (a.id && b.id && a.match !== 'fuzzy' && b.match !== 'fuzzy') pairs.add(pairKey(a.id, b.id));
  }
  return {
    ...m,
    nodes: m.nodes.filter((n) => !own.has(n.id) && !(n.group && ownG.has(n.group) && isProposed(n))),
    edges: m.edges.filter((e) => !(isProposed(e) && (own.has(e.from) || own.has(e.to) || pairs.has(pairKey(e.from, e.to)) || [e.from, e.to].some((x) => { const n = byId.get(x); return !!n?.group && ownG.has(n.group) && isProposed(n); })))),
    ...(m.groups ? { groups: m.groups.filter((g) => !ownG.has(g.id)) } : {}),
  };
}

// ================================================================== describe

const VERB: Record<EdgeKind, string> = { calls: 'calls', reads: 'reads', writes: 'writes to', publishes: 'publishes to', subscribes: 'subscribes to', imports: 'imports' };
/** One plain sentence for an op, in the model's labels ("Insert Orders cache between Checkout and Orders
 *  store"). Pass the spliced model to name nodes earlier ops added, and its marks so relationships the splice already
 *  retired don't count: "after X" when X fans out (or "before X" when several call it) says the new node is one more
 *  step ("Add Metrics, which Pipeline runner also calls"), as `applySplice` places it. */
export function describeOp(model: Model, op: SpliceOp, marks?: { edges: Record<string, EdgeMark> }): string {
  const glabel = (ref: unknown) => { if (!isStr(ref)) return '?'; const r = resolveGroupRef(model, ref); return r.id ? (model.groups ?? []).find((g) => g.id === r.id)?.label ?? r.id : ref; };
  const res = (ref: unknown) => {
    if (!isStr(ref)) return null;
    const r = resolveNodeRef(model, ref);
    return r.id && r.match !== 'fuzzy' ? model.nodes.find((x) => x.id === r.id) ?? null : null;
  };
  const lbl = (ref: unknown) => (isStr(ref) ? res(ref)?.label ?? humanize(ref) : '?');
  const live = (e: MEdge) => !isImport(e) && !(marks && (marks.edges[pairKey(e.from, e.to)] === 'removed' || marks.edges[pairKey(e.from, e.to)] === 'rerouted'));
  // a card with parts (a type and its methods) counts its parts' relationships, by card, as applySplice places it
  const card = foldRep(model.nodes);
  const fan = (ref: unknown, dir: 'in' | 'out') => {
    const x = res(ref)?.id;
    if (!x) return 0;
    const parts = new Set(model.nodes.filter((n) => card(n.id) === x).map((n) => n.id).concat(x));
    const far = model.edges.filter((e) => live(e) && (dir === 'in' ? parts.has(e.to) && !parts.has(e.from) : parts.has(e.from) && !parts.has(e.to))).map((e) => (dir === 'in' ? e.from : e.to));
    return new Set(parts.size > 1 ? far.map(card) : far).size;
  };
  const nodeName = (nd: unknown) => { const n = nd as SpliceNode | undefined; return nonEmpty(n?.label) ? n!.label : isStr(n?.id) ? humanize(n!.id) : 'a node'; };
  switch (op?.op) {
    case 'add': {
      const name = nodeName(op.node);
      // next to a proposed group's placeholder: the card goes into that group (applySplice puts it there)
      const phG = (ref: unknown) => { const n = res(ref); return n && isProposed(n) && n.group && n.id === entryId(n.group) ? n.group : null; };
      const intoG = [...(Array.isArray(op.between) ? op.between : []), op.before, op.after, op.attach?.to].map(phG).find((g) => !!g);
      if (intoG && !isStr(op.node?.group)) return describeOp(model, { op: 'add', node: { ...op.node, group: intoG } }, marks);
      if (Array.isArray(op.between)) return `Insert ${name} between ${lbl(op.between[0])} and ${lbl(op.between[1])}`;
      if (op.before !== undefined) return fan(op.before, 'in') > 1 ? `Add ${name}, which also calls ${lbl(op.before)}` : `Insert ${name} before ${lbl(op.before)}`;
      if (op.after !== undefined) return fan(op.after, 'out') > 1 ? `Add ${name}, which ${lbl(op.after)} also calls` : `Insert ${name} after ${lbl(op.after)}`;
      if (op.attach) { const v = VERB[op.attach.kind ?? 'calls'] ?? 'calls'; return op.attach.dir === 'in' ? `Add ${name}, which ${lbl(op.attach.to)} ${v}` : `Add ${name}, which ${v} ${lbl(op.attach.to)}`; }
      const g = isStr(op.node?.group) ? resolveGroupRef(model, op.node.group).id : null;
      if (!g) return `Add ${name}${isStr(op.node?.group) ? ` in ${op.node.group}` : ''}`;
      // the first card into a group with a placeholder takes over its relationships: say which
      const ph = model.nodes.find((n) => n.id === entryId(g) && isProposed(n));
      const ins = ph ? model.edges.filter((e) => live(e) && e.to === ph.id).map((e) => lbl(e.from)) : [];
      const outs = ph ? model.edges.filter((e) => live(e) && e.from === ph.id).map((e) => lbl(e.to)) : [];
      const also = [...(ins.length ? [`which ${ins.join(' and ')} call${ins.length === 1 ? 's' : ''}`] : []), ...(outs.length ? [`which calls ${outs.join(' and ')}`] : [])];
      return `Add ${name} in ${glabel(g)}${also.length ? `, ${also.join(', and ')}` : ''}`;
    }
    case 'group': {
      const gd = (op.group ?? {}) as SpliceGroup, name = nonEmpty(gd.label) ? gd.label : isStr(gd.id) ? humanize(gd.id) : 'a group';
      const where = isStr(gd.parent) && gd.parent ? ` in ${glabel(gd.parent)}` : '';
      const first = op.first && typeof op.first === 'object' && nonEmpty(op.first.label) ? ` with ${op.first.label}` : '';
      const v = VERB[op.attach?.kind ?? 'calls'] ?? 'calls', to = op.attach ? (resolveGroupRef(model, op.attach.to).id && !res(op.attach.to) ? glabel(op.attach.to) : lbl(op.attach.to)) : '';
      const att = op.attach ? (op.attach.dir === 'in' ? `, which ${to} ${v}` : `, which ${v} ${to}`) : '';
      return `Add group ${name}${where}${first}${att}`;
    }
    case 'connect': return `Connect ${lbl(op.from)} to ${lbl(op.to)}${op.kind && op.kind !== 'calls' ? ` (${op.kind})` : ''}${nonEmpty(op.label) ? `, labelled "${op.label}"` : ''}`;
    case 'disconnect': return `Disconnect ${lbl(op.from)} from ${lbl(op.to)}`;
    case 'remove': return op.group !== undefined || (!res(op.node) && resolveGroupRef(model, op.node ?? '').id) ? `Remove group ${glabel(op.group ?? op.node)}` : `Remove ${lbl(op.node)}`;
    case 'rename': return op.group !== undefined || (!res(op.node) && resolveGroupRef(model, op.node ?? '').id) ? `Rename group ${glabel(op.group ?? op.node)} to ${op.label}` : `Rename ${lbl(op.node)} to ${op.label}`;
    case 'move': return `Move ${lbl(op.node)} into ${glabel(op.group)}`;
    case 'replace': return `Replace ${lbl(op.node)} with ${isStr(op.with) ? lbl(op.with) : nodeName(op.with)}`;
    default: return `Unknown op ${JSON.stringify((op as any)?.op ?? null)}`;
  }
}

// ================================================================== validate

export interface SpliceIssue { level: 'error' | 'warn'; /** JSON pointer into the splice ("" is the whole thing). */ path: string; message: string; hint?: string }
const PLACEMENTS = ['between', 'before', 'after', 'attach'] as const;
const OP_KEYS: Record<SpliceOpName, string[]> = {
  add: ['op', 'node', ...PLACEMENTS], connect: ['op', 'from', 'to', 'kind', 'label'], disconnect: ['op', 'from', 'to'],
  remove: ['op', 'node', 'group'], rename: ['op', 'node', 'group', 'label'], move: ['op', 'node', 'group'], replace: ['op', 'node', 'with'],
  group: ['op', 'group', 'first', 'attach'],
};
const GROUP_KEYS = ['id', 'label', 'parent', 'summary'];
const NODE_KEYS = ['id', 'label', 'kind', 'category', 'tags', 'group', 'summary'];
const TOP_KEYS = ['$schema', 'karyo', 'id', 'title', 'note', 'base', 'view', 'created', 'updated', 'ops'];

/** Checks a splice file: its shape (spec/karyo-splice.schema.json), then what it means (ids, refs to nodes an
 *  earlier op adds, one placement per add). With `model`, also every op that wouldn't apply to it (`applySplice`'s
 *  warnings, as `warn`). Errors mean the file can't be used; warnings mean part of it won't show. */
export function validateSplice(json: unknown, model?: Model): SpliceIssue[] {
  const out: SpliceIssue[] = [];
  const err = (path: string, message: string, hint?: string) => out.push({ level: 'error', path, message, ...(hint ? { hint } : {}) });
  const warn = (path: string, message: string, hint?: string) => out.push({ level: 'warn', path, message, ...(hint ? { hint } : {}) });
  if (!json || typeof json !== 'object' || Array.isArray(json)) { err('', 'a splice is a JSON object'); return out; }
  const s = json as Record<string, any>;
  if (s.karyo !== SPLICE_FORMAT) err('/karyo', `expected "karyo": "${SPLICE_FORMAT}", got ${JSON.stringify(s.karyo)}`);
  if (!isStr(s.id) || !SPLICE_ID_RE.test(s.id)) err('/id', `id must be a file-name-safe word (letters, digits, _ . -), got ${JSON.stringify(s.id)}`, isStr(s.title) ? `e.g. "${slug(s.title)}"` : undefined);
  if (!nonEmpty(s.title)) err('/title', 'title must be a non-empty string');
  if (s.note !== undefined && !isStr(s.note)) err('/note', 'note must be a string');
  for (const k of Object.keys(s)) if (!TOP_KEYS.includes(k)) warn(`/${k}`, `unknown key "${k}"`);
  if (!s.base || typeof s.base !== 'object' || Array.isArray(s.base)) err('/base', 'base must be { model, commit, scene? }');
  else {
    if (!nonEmpty(s.base.model)) err('/base/model', 'base.model must be the model file (repo-relative path)');
    if (s.base.commit !== null && !isStr(s.base.commit)) err('/base/commit', 'base.commit must be a sha or null');
    if (s.base.scene !== undefined && !isStr(s.base.scene)) err('/base/scene', 'base.scene must be a string');
  }
  for (const k of ['created', 'updated'] as const) {
    if (!isStr(s[k])) err(`/${k}`, `${k} must be an ISO timestamp string`);
    else if (Number.isNaN(Date.parse(s[k]))) warn(`/${k}`, `${k} isn't a date: ${JSON.stringify(s[k])}`);
  }
  if (!Array.isArray(s.ops)) { err('/ops', 'ops must be a list'); return out; }
  const added = new Map<string, number>(), addedGroups = new Map<string, number>();
  const refCheck = (path: string, ref: unknown, i: number) => {
    if (!nonEmpty(ref)) return err(path, 'must name a node (an id)');
    if (ref.startsWith('splice.') && !added.has(ref) && !addedGroups.has(ref)) {
      const later = s.ops.findIndex((o: any, j: number) => j > i && ((o?.op === 'add' && o?.node?.id === ref) || (o?.op === 'replace' && o?.with?.id === ref) || (o?.op === 'group' && (o?.group?.id === ref || o?.first?.id === ref))));
      return err(path, `${ref} isn't added by an earlier op${later >= 0 ? ` (op ${later + 1} adds it: ops apply in order)` : ''}`);
    }
    if (!ID_RE.test(ref)) warn(path, `"${ref}" isn't an id; it will be matched by label, which breaks if the label changes`, 'save node ids');
  };
  /** A proposed node (add's `node`, replace's `with`): its shape; its id is remembered for later refs. */
  const newNode = (n: any, path: string, what: string, i: number): boolean => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) { err(path, `${what} needs a node object`); return false; }
    for (const k of Object.keys(n)) if (!NODE_KEYS.includes(k)) warn(`${path}/${k}`, `unknown node key "${k}"`);
    if (!nonEmpty(n.label)) err(`${path}/label`, 'the node needs a label');
    if (n.id !== undefined) {
      if (!isStr(n.id) || !ID_RE.test(n.id)) err(`${path}/id`, `not a valid node id: ${JSON.stringify(n.id)}`);
      else {
        if (!n.id.startsWith('splice.')) warn(`${path}/id`, `proposed node ids start with "splice." (${n.id})`, `e.g. ${slugId(n.label ?? n.id)}`);
        if (added.has(n.id)) err(`${path}/id`, `${n.id} is already added by op ${added.get(n.id)! + 1}`);
        added.set(n.id, i);
      }
    } else if (nonEmpty(n.label)) added.set(slugId(n.label, added.keys()), i);
    if (n.kind !== undefined && !isNodeKind(n.kind)) err(`${path}/kind`, `kind must be one of ${NODE_KINDS.join(', ')}, or a kit's kind (a lowercase word)`);
    if (n.tags !== undefined && (!Array.isArray(n.tags) || !n.tags.every(isStr))) err(`${path}/tags`, 'tags must be a list of strings');
    for (const k of ['category', 'group', 'summary']) if (n[k] !== undefined && !isStr(n[k])) err(`${path}/${k}`, `${k} must be a string`);
    return true;
  };
  s.ops.forEach((o: any, i: number) => {
    const p = `/ops/${i}`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return err(p, 'an op is an object');
    if (!SPLICE_OPS.includes(o.op)) return err(`${p}/op`, `unknown op ${JSON.stringify(o.op)}`, `use one of ${SPLICE_OPS.join(', ')}`);
    for (const k of Object.keys(o)) if (!OP_KEYS[o.op as SpliceOpName].includes(k)) warn(`${p}/${k}`, `unknown key "${k}" for ${o.op}`);
    switch (o.op as SpliceOpName) {
      case 'add': {
        if (!newNode(o.node, `${p}/node`, 'add', i)) break;
        const places = PLACEMENTS.filter((k) => o[k] !== undefined);
        if (places.length > 1) err(p, `an add goes one place; it has ${places.join(' and ')}`);
        if (o.between !== undefined) {
          if (!Array.isArray(o.between) || o.between.length !== 2) err(`${p}/between`, 'between is [from, to]');
          else { refCheck(`${p}/between/0`, o.between[0], i); refCheck(`${p}/between/1`, o.between[1], i); if (o.between[0] === o.between[1]) err(`${p}/between`, 'between names one node twice'); }
        }
        if (o.before !== undefined) refCheck(`${p}/before`, o.before, i);
        if (o.after !== undefined) refCheck(`${p}/after`, o.after, i);
        if (o.attach !== undefined) {
          if (!o.attach || typeof o.attach !== 'object') err(`${p}/attach`, 'attach is { to, dir?, kind? }');
          else {
            refCheck(`${p}/attach/to`, o.attach.to, i);
            if (o.attach.dir !== undefined && o.attach.dir !== 'in' && o.attach.dir !== 'out') err(`${p}/attach/dir`, 'dir is "out" or "in"');
            if (o.attach.kind !== undefined && !KIND_ORDER.has(o.attach.kind)) err(`${p}/attach/kind`, `kind must be one of ${RELATION_KINDS.join(', ')}`);
          }
        }
        break;
      }
      case 'connect': case 'disconnect':
        refCheck(`${p}/from`, o.from, i); refCheck(`${p}/to`, o.to, i);
        if (isStr(o.from) && o.from === o.to) err(p, `${o.op} names one node twice`);
        if (o.op === 'connect' && o.kind !== undefined && !KIND_ORDER.has(o.kind)) err(`${p}/kind`, `kind must be one of ${RELATION_KINDS.join(', ')}`);
        if (o.op === 'connect' && o.label !== undefined && !isStr(o.label)) err(`${p}/label`, 'label must be a string');
        break;
      case 'remove': case 'rename': {
        const both = o.node !== undefined && o.group !== undefined;
        if (both) err(p, `${o.op} names a node or a group, not both`);
        else if (o.group !== undefined) { if (!nonEmpty(o.group)) err(`${p}/group`, 'must name a group (an id)'); }
        else refCheck(`${p}/node`, o.node, i);
        if (o.op === 'rename' && !nonEmpty(o.label)) err(`${p}/label`, 'rename needs a new label');
        break;
      }
      case 'group': {
        const g = o.group;
        if (!g || typeof g !== 'object' || Array.isArray(g)) { err(`${p}/group`, 'group needs { "label": … }'); break; }
        for (const k of Object.keys(g)) if (!GROUP_KEYS.includes(k)) warn(`${p}/group/${k}`, `unknown group key "${k}"`);
        if (!nonEmpty(g.label)) err(`${p}/group/label`, 'the group needs a label');
        let gid: string | null = null;
        if (g.id !== undefined) {
          if (!isStr(g.id) || !ID_RE.test(g.id)) err(`${p}/group/id`, `not a valid group id: ${JSON.stringify(g.id)}`);
          else { if (addedGroups.has(g.id)) err(`${p}/group/id`, `${g.id} is already added by op ${addedGroups.get(g.id)! + 1}`); gid = g.id; }
        } else if (nonEmpty(g.label)) gid = slugId(g.label, addedGroups.keys());
        if (gid) { addedGroups.set(gid, i); added.set(entryId(gid), i); }
        for (const k of ['parent', 'summary']) if (g[k] !== undefined && !isStr(g[k])) err(`${p}/group/${k}`, `${k} must be a string`);
        if (o.first !== undefined) newNode(o.first, `${p}/first`, 'first', i);
        if (o.attach !== undefined) {
          if (!o.attach || typeof o.attach !== 'object') err(`${p}/attach`, 'attach is { to, dir?, kind? }');
          else {
            refCheck(`${p}/attach/to`, o.attach.to, i);
            if (o.attach.dir !== undefined && o.attach.dir !== 'in' && o.attach.dir !== 'out') err(`${p}/attach/dir`, 'dir is "in" (to → the group) or "out" (the group → to)');
            if (o.attach.kind !== undefined && !KIND_ORDER.has(o.attach.kind)) err(`${p}/attach/kind`, `kind must be one of ${RELATION_KINDS.join(', ')}`);
          }
        }
        break;
      }
      case 'move': refCheck(`${p}/node`, o.node, i); if (!nonEmpty(o.group)) err(`${p}/group`, 'move needs a group'); break;
      case 'replace':
        refCheck(`${p}/node`, o.node, i);
        if (isStr(o.with)) { refCheck(`${p}/with`, o.with, i); if (o.with === o.node) err(p, 'replace names one node twice'); }
        else if (o.with === undefined) err(`${p}/with`, 'replace needs "with": a new node { "label": … } or a node that exists');
        else newNode(o.with, `${p}/with`, 'replace', i);
        break;
    }
  });
  if (model && !out.some((x) => x.level === 'error'))
    for (const w of applySplice(model, s as Splice).warnings) out.push({ level: 'warn', path: w.op >= 0 ? `/ops/${w.op}` : '/ops', message: w.message, ...(w.hint ? { hint: w.hint } : {}) });
  return out;
}

// ================================================================== landed

export type SpliceOpStatus = 'pending' | 'landed' | 'conflict';
/** Per op: has the real code caught up with it? `landed`: the real model now has it (a node with the proposed
 *  id, or with the same label and the proposed neighbours; the relationship; the removal, rename or move).
 *  `pending`: not yet, and it still applies. `conflict`: not yet, and it no longer applies (a node it names is
 *  gone, the relationship it inserts into was removed). Proposed items in `model` are ignored. */
export function landed(model: Model, splice: Splice): SpliceOpStatus[] { return landedDetail(model, splice).map((x) => x.status); }
export function landedDetail(model: Model, splice: Splice): { status: SpliceOpStatus; reason: string }[] {
  const real: Model = normalize({ ...model, nodes: (model.nodes ?? []).filter((n) => !isProposed(n)), edges: (model.edges ?? []).filter((e) => !isProposed(e)), flows: model.flows ?? [] });
  const ops: SpliceOp[] = Array.isArray(splice?.ops) ? splice.ops : [];
  const rels = new Set(real.edges.filter((e) => !isImport(e)).map((e) => pairKey(e.from, e.to)));
  // a card with parts (a type and its methods) has the relationships of its parts, as the board draws it
  const card = foldRep(real.nodes);
  const cardRels = new Set(real.edges.filter((e) => !isImport(e)).map((e) => pairKey(card(e.from), card(e.to))));
  const has = (a: string | null, b: string | null) => !!a && !!b && (rels.has(pairKey(a, b)) || (card(a) === a && card(b) === b && cardRels.has(pairKey(a, b))));
  const map = new Map<string, string>(); // proposed id → the real node that landed it
  const addedBy = new Map<string, number>();
  const find = (ref: unknown): string | null => {
    if (!isStr(ref)) return null;
    const r = resolveNodeRef(real, map.get(ref) ?? ref);
    return r.id && (r.match === 'id' || r.match === 'label') ? r.id : null;
  };
  const unlanded = (ref: unknown) => isStr(ref) && addedBy.has(ref) && !map.has(ref);
  // groups: the ones this splice adds (proposed id → the real group that landed it, or '' while it hasn't), and a group of
  // the code by id or label
  const gAdded = new Map<string, string>();
  const realGroup = (ref: string) => { const r = resolveGroupRef(real, ref); return r.id ? (real.groups ?? []).find((g) => g.id === r.id) ?? { id: r.id } : null; };
  const out: ({ status: SpliceOpStatus; reason: string } | null)[] = ops.map(() => null);
  ops.forEach((op, i) => {
    const done = (reason: string) => { out[i] = { status: 'landed', reason }; };
    switch (op?.op) {
      case 'add': {
        const label = op.node?.label ?? '';
        const id = isStr(op.node?.id) ? op.node.id : slugId(label);
        addedBy.set(id, i);
        const byId = real.nodes.find((n) => n.id === id && n.kind !== 'module');
        if (byId) { map.set(id, byId.id); return done(`${id} is in the model`); }
        const fits = (c: string) => {
          if (Array.isArray(op.between)) { const a = find(op.between[0]), b = find(op.between[1]); return (has(a, c) && has(c, b)) || (has(b, c) && has(c, a)); }
          if (op.before !== undefined) return has(c, find(op.before));
          if (op.after !== undefined) return has(find(op.after), c);
          if (op.attach) { const t = find(op.attach.to); return op.attach.dir === 'in' ? has(t, c) : has(c, t); }
          return true;
        };
        const cand = real.nodes.find((n) => n.kind !== 'module' && fold(n.label ?? '') === fold(label) && fold(label) && fits(n.id));
        if (cand) { map.set(id, cand.id); return done(`${cand.label ?? cand.id} (${cand.id}) is in the model, in place`); }
        return;
      }
      case 'connect': { const a = find(op.from), b = find(op.to); if (has(a, b)) done(`${a} → ${b} is in the model`); return; }
      case 'disconnect': {
        if (unlanded(op.from) || unlanded(op.to)) return;
        const a = find(op.from), b = find(op.to);
        if (!has(a, b)) done(`${op.from} → ${op.to} is not in the model`);
        return;
      }
      case 'remove': {
        if (op.group !== undefined) { if (!gAdded.has(op.group) && !realGroup(op.group)) done(`the group ${op.group} is not in the model`); return; }
        if (!unlanded(op.node) && !find(op.node)) done(`${op.node} is not in the model`);
        return;
      }
      case 'rename': {
        if (op.group !== undefined) { const g = realGroup(gAdded.get(op.group) ?? op.group); if (g && (g.label ?? g.id) === op.label) done(`the group ${g.id} is called "${op.label}"`); return; }
        const x = find(op.node); if (x && real.nodes.find((n) => n.id === x)?.label === op.label) done(`${x} is called "${op.label}"`);
        return;
      }
      case 'group': {
        // landed: the code has the group (by the proposed id or its label) and, when attached, a relationship between it and `to`
        const gd = op.group, label = gd?.label ?? '';
        if (!gd || typeof gd !== 'object') return;
        const id = isStr(gd.id) ? gd.id : slugId(label, gAdded.keys());
        const g = realGroup(id) ?? realGroup(label);
        if (op.first && typeof op.first === 'object') addedBy.set(isStr(op.first.id) ? op.first.id : slugId(op.first.label ?? ''), i);
        if (!g) { gAdded.set(id, ''); return; }
        gAdded.set(id, g.id);
        if (!op.attach) return done(`the group ${g.label ?? g.id} is in the model`);
        const t = find(op.attach.to), inside = real.nodes.filter((n) => n.group === g.id).map((n) => n.id);
        if (inside.some((c) => (op.attach!.dir === 'in' ? has(t, c) : has(c, t)))) done(`the group ${g.label ?? g.id} is in the model, connected to ${op.attach.to}`);
        return;
      }
      case 'move': { const x = find(op.node); if (x && real.nodes.find((n) => n.id === x)?.group === op.group) done(`${x} is in ${op.group}`); return; }
      case 'replace': {
        // landed: X is gone and Y is there (by the proposed id, or a node with its label)
        let y: string | null = null;
        if (isStr(op.with)) y = find(op.with);
        else if (op.with && typeof op.with === 'object') {
          const w = op.with, id = isStr(w.id) ? w.id : slugId(w.label ?? '');
          addedBy.set(id, i);
          const hit = real.nodes.find((n) => n.kind !== 'module' && (n.id === id || (fold(n.label ?? '') === fold(w.label ?? '') && fold(w.label ?? ''))));
          if (hit) { map.set(id, hit.id); y = hit.id; }
        }
        if (y && !unlanded(op.node) && !find(op.node)) done(`${op.node} is not in the model and ${y} is`);
        return;
      }
    }
  });
  // the rest: does it still apply to the real model (with what landed already there)?
  const skip = new Set(out.flatMap((x, i) => (x ? [i] : [])));
  const mapped = ops.map((op) => mapRefs(op, (r) => map.get(r) ?? r));
  const w = new Work(real);
  w.run(mapped, skip);
  return out.map((x, i) => {
    if (x) return x;
    const ws = w.warnings.filter((v) => v.op === i);
    return ws.length ? { status: 'conflict', reason: ws.map((v) => v.message).join(' ') } : { status: 'pending', reason: 'not in the model yet' };
  });
}
/** An op with every node reference passed through `f` (not the ids of the nodes it proposes). */
export function mapRefs(op: SpliceOp, f: (ref: string) => string): SpliceOp {
  const m = (r: unknown) => (isStr(r) ? f(r) : r) as string;
  switch (op?.op) {
    case 'add': return { ...op, ...(Array.isArray(op.between) ? { between: [m(op.between[0]), m(op.between[1])] as [string, string] } : {}), ...(op.before !== undefined ? { before: m(op.before) } : {}), ...(op.after !== undefined ? { after: m(op.after) } : {}), ...(op.attach ? { attach: { ...op.attach, to: m(op.attach.to) } } : {}) };
    case 'connect': case 'disconnect': return { ...op, from: m(op.from), to: m(op.to) };
    case 'remove': case 'rename': return op.node === undefined ? op : ({ ...op, node: m(op.node) } as SpliceOp);
    case 'move': return { ...op, node: m(op.node) };
    case 'group': return op.attach ? { ...op, attach: { ...op.attach, to: m(op.attach.to) } } : op;
    case 'replace': return { ...op, node: m(op.node), with: isStr(op.with) ? m(op.with) : op.with };
    default: return op;
  }
}
