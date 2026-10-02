// A stack of splices (docs/ENGINE.md "Stack of splices"): the real view, then one slice per splice (each applied
// over the same base model, with its marks), and optionally one more slice that combines several splices in order,
// for the Stack view (src/model/stack.ts) to compare. And the combining itself (docs/MODEL.md "Combining splices"):
// what the combination is, in either order, and everything a person should know about it, so nothing is silently lost:
// conflicts (two splices disagree), consequences (a change lost, a proposal left dangling), whether the order changes
// the result, proposals two splices agree on, changes that follow another splice's replacement, and two different
// proposals that share a name. Pure (no DOM, no fs): the board, the tests and Jarvis's page use it. Shape-neutral:
// every word comes from the splices' titles, the model's labels and the core's descriptions (describeOp).
import { applySplice, boardMarks, describeOp, entryId, groupIds, mapRefs, resolveNodeRef, slug, slugId, type Splice, type SpliceGroup, type SpliceNode, type SpliceOp, type SpliceResult } from './splice';
import { isImport, pairKey, type Model } from './model';
import type { StackSlice, WarningItem } from './stack-diff';

/** One splice in a stack: `key` identifies it (its file, or the open splice), `unsaved` when what is shown isn't saved. */
export interface SpliceLayer { key: string; title: string; splice: Splice; unsaved?: boolean }

/** What combining splices can find. `conflict`: two splices disagree about one thing (rename it two ways, disconnect
 *  what the other routes through, two inserts into one relationship, remove or replace what the other renames …).
 *  `lost`: a change from one splice that another undoes (it removes what the change needs). `dangling`: a proposed node
 *  left with nothing on a side it had in its own splice. `order`: the result differs by order. `agreed`: two splices
 *  propose the very same thing (shown once). `follows`: a change that now applies to what another splice put in place
 *  of its node (a replace). `same-name`: two different proposals with one name (the same thing?). */
export type SpliceIssueKind = 'conflict' | 'lost' | 'dangling' | 'order' | 'agreed' | 'follows' | 'same-name';
/** How the list, the card and the key group them (lost and dangling are both consequences; a same-name pair the person
 *  said is one thing is `same`). */
export type SpliceIssueGroup = 'conflict' | 'consequence' | 'order' | 'same-name' | 'same' | 'agreed' | 'follows';
/** The words the key, the list, the card and Jarvis share: a name, a symbol, a tone (warn: the warning colour; ask: a
 *  question; note: quiet) and what it means. */
export const ISSUE_WORDS: Record<SpliceIssueGroup, { name: string; sym: string; tone: 'warn' | 'ask' | 'note'; meaning: string }> = {
  conflict: { name: 'conflict', sym: '⚠', tone: 'warn', meaning: 'two splices disagree' },
  consequence: { name: 'consequence', sym: '⚠', tone: 'warn', meaning: 'a change lost or left dangling' },
  order: { name: 'order', sym: '⇄', tone: 'warn', meaning: 'the order changes the result' },
  'same-name': { name: 'same name', sym: '?', tone: 'ask', meaning: 'one name, two things?' },
  same: { name: 'same thing', sym: '=', tone: 'note', meaning: 'one thing, in this combination only' },
  agreed: { name: 'agreed', sym: '✓', tone: 'note', meaning: 'proposed by both, shown once' },
  follows: { name: 'follows', sym: '→', tone: 'note', meaning: 'follows a replacement' },
};
/** What a conflict is, in the words the legend, the header, the conflict card and Jarvis share. */
export const CONFLICT_MEANING = ISSUE_WORDS.conflict.meaning;

/** One thing combining found. Every kind is explained the same way: `subject` (what it is about, in the model's labels),
 *  `parts` (what each splice involved does to it, in describeOp's words said of it) and `result` (what the combination
 *  shows). */
export interface SpliceConflict {
  kind: SpliceIssueKind;
  group: SpliceIssueGroup;
  /** The layers involved (indices into the list given), in order. */
  layers: number[];
  /** Node ids and relationships (`pairKey`) it concerns, as they are in the combination. */
  nodes: string[];
  pairs: string[];
  /** The change it is about (its layer, its index in that splice), when it is about one. */
  op?: { layer: number; index: number };
  message: string;
  subject: string;
  parts: ConflictPart[];
  result: string;
  /** `same-name`: the key that records "treat them as the same" in the combination (`CombineOpts.same`), and whether it is. */
  same?: { key: string; unified: boolean };
}
export type SpliceIssue = SpliceConflict;
/** A part: a layer (-1: none, e.g. one order of the splices), its title, what it does, and which of its changes. */
export interface ConflictPart { layer: number; title: string; does: string[]; /** Indices of those changes in that layer's splice. */ ops: number[] }
export interface CombinedSplices {
  /** One splice holding every layer's changes in order (id and title joined from the layers'), as applied: proposed ids
   *  kept apart per splice, agreed changes once. */
  splice: Splice;
  result: SpliceResult;
  /** Which layer and change each combined change came from. */
  origin: { layer: number; index: number }[];
  /** Which changes came from which layer: `[from, to)` in the combined ops. */
  parts: { layer: number; from: number; to: number }[];
  /** Everything combining found (every kind), conflicts first. */
  conflicts: SpliceConflict[];
  /** Changes that don't apply even on their own splice (not the combining's doing). */
  warnings: { layer: number; index: number; message: string }[];
  /** The layers' titles in the order applied ("Caching", "Queueing"). */
  order: string[];
  /** The other order (every layer reversed): its titles, its result, and whether it differs from this one. */
  other: { order: string[]; result: SpliceResult; differs: boolean } | null;
}
export interface CombineOpts {
  title?: string;
  /** Pairs of proposals the person said are one thing (`SpliceConflict.same.key`), recorded in the combination only. */
  same?: string[];
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** "a", "a and b", "a, b and c". */
const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** describeOp's imperative, said of a splice: "Insert X between …" → "inserts X between …". */
const says = (w: string) => w.replace(/^([A-Z][a-z]+)/, (v) => `${v.toLowerCase()}${/(s|sh|ch|x|z)$/.test(v.toLowerCase()) ? 'es' : 's'}`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** English plural of a name's last word ("Read cache" → "Read caches"). */
const plur = (s: string) => s.replace(/(\w+)$/, (w) => (/(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`));
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\s*the\s+/, '').replace(/[^a-z0-9]+/g, '');
const isStr = (x: unknown): x is string => typeof x === 'string';
const opsOf = (s: Splice | undefined): SpliceOp[] => (Array.isArray(s?.ops) ? s!.ops : []);

/** A splice's changes, one line each, naming nodes as they were just before that change (a rename says the old name),
 *  and counting only the relationships the splice still has (so "after X" says whether X fans out). */
export function describeSplice(base: Model, splice: Splice): string[] {
  const ops = opsOf(splice);
  return ops.map((op, i) => {
    if (i === 0) return describeOp(base, op);
    const r = applySplice(base, { ...splice, ops: ops.slice(0, i) });
    return describeOp(r.model, op, r.marks);
  });
}

/** What one change does, resolved in base terms (a node of the base model, or the id a splice proposes). */
interface Desc {
  l: number; i: number; op: SpliceOp; words: string;
  /** The node it acts on: remove, rename, move, replace (X). */
  node?: string;
  /** The node it proposes (add, replace with a new node) and that node's name. */
  made?: string; label?: string;
  /** replace: Y. */
  with?: string;
  /** connect, disconnect: the relationship. */
  pair?: [string, string];
  /** An add that goes into a relationship (between; before or after a node with one caller or callee). */
  into?: [string, string];
  /** Where an add (or a replace's new node) goes, relative to one node, for plain words. */
  near?: { rel: 'front' | 'behind' | 'calls' | 'called' | 'instead'; x: string };
  /** Every node it needs to be there. */
  uses: string[];
  /** The group it proposes (its id in the combination) and that group's name; or the group it renames or removes. */
  group?: string; groupLabel?: string;
}

/** Several splices as one what-if: every layer's changes, in the order given, applied as one splice over `base` (so each
 *  change sees what the earlier layers proposed and took away, and a node another splice replaced means its
 *  replacement), and the same in the other order. What it finds (`conflicts`, every kind of `SpliceIssueKind`) is
 *  checked pair by pair, both ways, so it doesn't depend on the order, and against what each splice does on its own, so
 *  nothing is silently lost. Proposed ids are kept apart per splice (two different "Read cache" proposals stay two
 *  cards), identical proposals are applied once. Never throws. */
export function combineSplices(base: Model, layers: { title: string; splice: Splice }[], o: CombineOpts = {}): CombinedSplices {
  const N = layers.length, titles = layers.map((l) => l.title);
  const baseIds = new Set(base.nodes.map((n) => n.id));
  const baseRel = base.edges.filter((e) => !isImport(e));
  const bLabel = new Map(base.nodes.map((n) => [n.id, n.label ?? n.id]));

  // ---- 1. each layer's proposals, with explicit ids (an id-less one gets the id it would get on its own)
  type Prop = { l: number; i: number; id: string; label: string; group?: boolean };
  const props: Prop[][] = layers.map((L, l) => {
    const taken = new Set(baseIds), out: Prop[] = [];
    opsOf(L.splice).forEach((op, i) => {
      const nd = (op?.op === 'add' ? op.node : op?.op === 'replace' && op.with && typeof op.with === 'object' ? op.with : op?.op === 'group' && op.first && typeof op.first === 'object' ? op.first : null) as SpliceNode | null;
      if (!nd || typeof nd !== 'object') return;
      const label = typeof nd.label === 'string' && nd.label.trim() ? nd.label.trim() : isStr(nd.id) ? nd.id : '';
      if (!label) return;
      const id = isStr(nd.id) ? nd.id : slugId(label, taken);
      taken.add(id);
      out.push({ l, i, id, label });
    });
    return out;
  });
  const propAt = (l: number, i: number) => props[l]!.find((p) => p.i === i);
  // the groups each layer proposes, with explicit ids (as each would get on its own)
  const baseGroups = new Set(groupIds(base));
  const gprops: Prop[][] = layers.map((L, l) => {
    const taken = new Set(baseGroups), out: Prop[] = [];
    opsOf(L.splice).forEach((op, i) => {
      if (op?.op !== 'group' || !op.group || typeof op.group !== 'object') return;
      const label = typeof op.group.label === 'string' && op.group.label.trim() ? op.group.label.trim() : isStr(op.group.id) ? op.group.id : '';
      if (!label) return;
      const id = isStr(op.group.id) ? op.group.id : slugId(label, taken);
      taken.add(id);
      out.push({ l, i, id, label, group: true });
    });
    return out;
  });
  const gpropAt = (l: number, i: number) => gprops[l]!.find((p) => p.i === i);
  const canonG: Map<string, string>[] = layers.map(() => new Map());   // a layer's proposed group id → its id in the combination
  /** A layer's group reference (one it proposes, by id or name) as the combination names it; others as they are. */
  const gid = (l: number, ref: unknown): unknown => {
    if (!isStr(ref)) return ref;
    if (canonG[l]!.has(ref)) return canonG[l]!.get(ref)!;
    const own = gprops[l]!.find((p) => fold(p.label) === fold(ref.replace(/\s+group\s*$/i, '')));
    return own ? canonG[l]!.get(own.id) ?? own.id : ref;
  };

  // ---- 2. a layer's references in base terms (its own proposals by id or label)
  const canon: Map<string, string>[] = layers.map(() => new Map());    // a layer's proposal id → its id in the combination
  const rid = (l: number, ref: unknown): string | null => {
    if (!isStr(ref) || !ref.trim()) return null;
    if (canon[l]!.has(ref)) return canon[l]!.get(ref)!;
    const r = resolveNodeRef(base, ref);
    if (r.id && (r.match === 'id' || r.match === 'label')) return r.id;
    const own = props[l]!.find((p) => fold(p.label) === fold(ref));
    return own ? canon[l]!.get(own.id) ?? own.id : null;
  };
  const refKey = (l: number, ref: unknown) => rid(l, ref) ?? `?${isStr(ref) ? fold(ref) : ''}`;
  /** A change's signature: equal signatures from two splices are the same proposal (agreed). */
  const sig = (l: number, op: SpliceOp): string | null => {
    switch (op?.op) {
      case 'add': {
        const n = op.node ?? ({} as SpliceNode), where = Array.isArray(op.between) ? `between:${refKey(l, op.between[0])}>${refKey(l, op.between[1])}`
          : op.before !== undefined ? `before:${refKey(l, op.before)}` : op.after !== undefined ? `after:${refKey(l, op.after)}`
          : op.attach ? `attach:${refKey(l, op.attach.to)}:${op.attach.dir ?? 'out'}:${op.attach.kind ?? 'calls'}` : 'free';
        return `add|${fold(n.label ?? n.id ?? '')}|${n.kind ?? 'service'}|${where}`;
      }
      case 'replace': return `replace|${refKey(l, op.node)}|${isStr(op.with) ? refKey(l, op.with) : `new:${fold(op.with?.label ?? '')}:${op.with?.kind ?? ''}`}`;
      case 'connect': return `connect|${refKey(l, op.from)}|${refKey(l, op.to)}|${op.kind ?? 'calls'}`;
      case 'disconnect': return `disconnect|${refKey(l, op.from)}|${refKey(l, op.to)}`;
      case 'remove': return op.group !== undefined ? `remove-group|${String(gid(l, op.group))}` : `remove|${refKey(l, op.node)}`;
      case 'rename': return op.group !== undefined ? `rename-group|${String(gid(l, op.group))}|${(op.label ?? '').trim()}` : `rename|${refKey(l, op.node)}|${(op.label ?? '').trim()}`;
      case 'move': return `move|${refKey(l, op.node)}|${String(gid(l, op.group))}`;
      case 'group': {
        const g = op.group ?? ({} as SpliceGroup);
        return `group|${fold(g.label ?? g.id ?? '')}|${isStr(g.parent) ? String(gid(l, g.parent)) : ''}|${fold(op.first?.label ?? '')}|${op.attach ? `${refKey(l, op.attach.to)}:${op.attach.dir ?? 'out'}:${op.attach.kind ?? 'calls'}` : ''}`;
      }
    }
    return null;
  };

  // ---- 3. agreement, same names, and ids kept apart: decided in the order given, so every order uses the same ids
  const group: Map<number, number>[] = layers.map(() => new Map());    // op index → its group of identical changes
  const groups: { sig: string; members: { l: number; i: number }[] }[] = [];
  const bySig = new Map<string, number>();
  const used = new Set<string>(baseIds);                                 // ids given out in the combination
  const relabel: Map<string, string>[] = layers.map(() => new Map());  // proposal id → its label in the combination
  const sameKeys = new Set(o.same ?? []);
  type Pair = { key: string; a: Prop; b: Prop; unified: boolean };
  const pairs: Pair[] = [];
  const unifiedTo: Map<string, string>[] = layers.map(() => new Map()); // proposal id → the combined id it is one with
  const pkey = (p: Prop) => `${layers[p.l]!.splice?.id ?? p.l}/${p.id}`;
  const gkey = (p: Prop) => `${layers[p.l]!.splice?.id ?? p.l}/group:${p.id}`;
  const usedG = new Set<string>(baseGroups);
  const relabelG: Map<string, string>[] = layers.map(() => new Map());
  const unifiedG: Map<string, string>[] = layers.map(() => new Map()); // proposal group id → the combined group it is one with
  for (let l = 0; l < N; l++) {
    opsOf(layers[l]!.splice).forEach((op, i) => {
      const s = sig(l, op);
      const prop = propAt(l, i);
      const g = s !== null ? bySig.get(s) : undefined;
      const gp = gpropAt(l, i);
      if (g !== undefined && !groups[g]!.members.some((m) => m.l === l)) {
        groups[g]!.members.push({ l, i });
        group[l]!.set(i, g);
        // the same proposal: the same node (and the same group)
        const f = groups[g]!.members[0]!;
        if (prop) { const fp = propAt(f.l, f.i); if (fp) canon[l]!.set(prop.id, canon[f.l]!.get(fp.id) ?? fp.id); }
        if (gp) { const fg = gpropAt(f.l, f.i); if (fg) canonG[l]!.set(gp.id, canonG[f.l]!.get(fg.id) ?? fg.id); }
        return;
      }
      if (s !== null && g === undefined) { bySig.set(s, groups.length); groups.push({ sig: s, members: [{ l, i }] }); group[l]!.set(i, groups.length - 1); }
      if (gp) {
        // an earlier splice's group with the same name: two different groups, unless the person said they are one
        const earlierG = gprops.slice(0, l).flat().filter((p) => fold(p.label) === fold(gp.label));
        for (const p of earlierG) {
          const key = [gkey(p), gkey(gp)].sort().join(' = ');
          const unified = sameKeys.has(key);
          pairs.push({ key, a: p, b: gp, unified });
          if (unified && !unifiedG[l]!.has(gp.id)) { const to = canonG[p.l]!.get(p.id) ?? p.id; unifiedG[l]!.set(gp.id, to); canonG[l]!.set(gp.id, to); }
        }
        if (!canonG[l]!.has(gp.id)) {
          let id = gp.id;
          if (usedG.has(id)) { const sp = slug(layers[l]!.splice?.id || layers[l]!.title || `splice-${l + 1}`); id = `${gp.id}.${sp}`; for (let n = 2; usedG.has(id); n++) id = `${gp.id}.${sp}-${n}`; }
          usedG.add(id);
          canonG[l]!.set(gp.id, id);
          if (earlierG.length) relabelG[l]!.set(gp.id, `${gp.label} (${layers[l]!.title})`);
        }
      }
      if (!prop) return;
      // an earlier splice's proposal with the same name: two different things, unless the person said they are one
      const earlier = props.slice(0, l).flat().filter((p) => fold(p.label) === fold(prop.label));
      for (const p of earlier) {
        const key = [pkey(p), pkey(prop)].sort().join(' = ');
        const unified = sameKeys.has(key);
        pairs.push({ key, a: p, b: prop, unified });
        if (unified && !unifiedTo[l]!.has(prop.id)) {
          const to = canon[p.l]!.get(p.id) ?? p.id;
          unifiedTo[l]!.set(prop.id, to); unifiedTo[p.l]!.set(p.id, to); canon[l]!.set(prop.id, to);
        }
      }
      if (canon[l]!.has(prop.id)) return;
      // its id in the combination: its own, unless another splice already proposes that id (then kept apart)
      let id = prop.id;
      if (used.has(id)) { const sp = slug(layers[l]!.splice?.id || layers[l]!.title || `splice-${l + 1}`); id = `${prop.id}.${sp}`; for (let n = 2; used.has(id); n++) id = `${prop.id}.${sp}-${n}`; }
      used.add(id);
      canon[l]!.set(prop.id, id);
      if (earlier.length) relabel[l]!.set(prop.id, `${prop.label} (${layers[l]!.title})`);
    });
  }
  /** The group of identical changes a change is in, when two splices or more make it. */
  const agreedOf = (l: number, i: number) => { const g = group[l]!.get(i); return g !== undefined && groups[g]!.members.length > 1 ? g : undefined; };

  // ---- 4. each layer's changes as they apply in the combination (its proposals under their combined ids)
  const rew: SpliceOp[][] = layers.map((L, l) => opsOf(L.splice).map((op, i) => {
    if (!op || typeof op !== 'object') return op;
    let x = mapRefs(op, (r) => canon[l]!.get(r) ?? r);
    // the groups it proposes or names, under their ids in the combination
    const G = (r: unknown) => gid(l, r) as string;
    if (x.op === 'add' && x.node && typeof x.node === 'object' && isStr(x.node.group)) x = { ...x, node: { ...x.node, group: G(x.node.group) } };
    else if (x.op === 'move') x = { ...x, group: G(x.group) };
    else if ((x.op === 'rename' || x.op === 'remove') && x.group !== undefined) x = { ...x, group: G(x.group) } as SpliceOp;
    else if (x.op === 'connect' || x.op === 'disconnect') x = { ...x, from: canon[l]!.has(x.from) ? x.from : G(x.from), to: canon[l]!.has(x.to) ? x.to : G(x.to) };
    else if (x.op === 'group' && x.group && typeof x.group === 'object') {
      const gp = gpropAt(l, i), lb = gp ? relabelG[l]!.get(gp.id) : undefined;
      x = { ...x, group: { ...x.group, ...(gp ? { id: canonG[l]!.get(gp.id) ?? gp.id } : {}), ...(lb ? { label: lb } : {}), ...(isStr(x.group.parent) ? { parent: G(x.group.parent) } : {}) } };
      if (x.attach && !canon[l]!.has(x.attach.to)) x = { ...x, attach: { ...x.attach, to: G(x.attach.to) } };
    }
    const p = propAt(l, i);
    if (!p) return x;
    const node = (nd: SpliceNode) => { const lb = relabel[l]!.get(p.id); return { ...nd, id: canon[l]!.get(p.id) ?? p.id, ...(lb ? { label: lb } : {}) }; };
    if (x.op === 'add' && x.node && typeof x.node === 'object') return { ...x, node: node(x.node) };
    if (x.op === 'replace' && x.with && typeof x.with === 'object') return { ...x, with: node(x.with) };
    if (x.op === 'group' && x.first && typeof x.first === 'object') return { ...x, first: node(x.first) };
    return x;
  }));
  const fwd = layers.map((_, l) => l);
  const first = layers[0]?.splice;
  const mkSplice = (ops: SpliceOp[], order: number[]): Splice => ({
    karyo: 'splice/1', id: order.map((l) => layers[l]!.splice?.id || 'splice').join('+'), title: order === fwd && o.title ? o.title : order.map((l) => titles[l]).join(', then '),
    base: first?.base ?? { model: '', commit: null }, view: {}, created: first?.created ?? '', updated: first?.updated ?? '', ops,
  });
  /** The combination in one order: identical changes once (the first to run), a unified proposal made once (the other
   *  placed as the same node). */
  const run = (order: number[]) => {
    const ops: SpliceOp[] = [], origin: { layer: number; index: number }[] = [], done = new Set<string>();
    for (const l of order) rew[l]!.forEach((op, i) => {
      const g = agreedOf(l, i);
      if (g !== undefined) { if (done.has(`g${g}`)) return; done.add(`g${g}`); }
      let x = op;
      // a group treated as the same as another splice's: made once, the second only adds its card and relationship
      const gp = gpropAt(l, i), gto = gp ? unifiedG[l]!.get(gp.id) ?? (unifiedG.some((u) => [...u.values()].includes(canonG[l]!.get(gp.id) ?? '')) ? canonG[l]!.get(gp.id) : undefined) : undefined;
      if (gto && x.op === 'group') { if (done.has(`ug:${gto}`)) x = { ...x, group: { ...x.group, id: gto }, $reuse: true } as SpliceOp; else done.add(`ug:${gto}`); }
      const p = propAt(l, i), to = p ? unifiedTo[l]!.get(p.id) : undefined;
      if (to) {
        if (done.has(`u:${to}`)) x = x.op === 'add' ? ({ ...x, node: { ...x.node, id: to }, $reuse: true } as SpliceOp) : x.op === 'replace' ? { ...x, with: to } : x;
        else { done.add(`u:${to}`); if (x.op === 'add') x = { ...x, node: { ...x.node, id: to } }; else if (x.op === 'replace' && typeof x.with === 'object') x = { ...x, with: { ...x.with, id: to } }; }
      }
      ops.push(x); origin.push({ layer: l, index: i });
    });
    return { ops, origin, result: applySplice(base, mkSplice(ops, order)) };
  };
  const main = run(fwd), back = N >= 2 ? run([...fwd].reverse()) : null;
  const splice = mkSplice(main.ops, fwd), result = main.result;
  const parts: CombinedSplices['parts'] = fwd.map((l) => {
    const at = main.origin.map((x, k) => (x.layer === l ? k : -1)).filter((k) => k >= 0);
    return { layer: l, from: at[0] ?? main.origin.length, to: at.length ? at[at.length - 1]! + 1 : main.origin.length };
  });
  const combIndex = (l: number, i: number) => main.origin.findIndex((x) => x.layer === l && x.index === i);
  const alone = layers.map((L, l) => applySplice(base, { ...L.splice, ops: rew[l]! }));

  // ---- names and words
  const labels = new Map<string, string>();
  for (const m of [result.model, ...(back ? [back.result.model] : []), ...alone.map((r) => r.model), base]) for (const n of m.nodes) if (!labels.has(n.id)) labels.set(n.id, n.label ?? n.id);
  /** A node's name as the people who wrote the splices knew it: the base model's label, else the proposal's. */
  const phLabel = new Map<string, string>();
  for (const r of [result, ...(back ? [back.result] : []), ...alone]) for (const [ph, g] of Object.entries(r.marks.placeholders ?? {})) if (!phLabel.has(ph)) phLabel.set(ph, `the ${r.model.groups?.find((x) => x.id === g)?.label ?? g} group`);
  const lbl = (id: string) => bLabel.get(id) ?? phLabel.get(id) ?? labels.get(id) ?? id;
  const pw = (a: string, b: string) => `${lbl(a)} → ${lbl(b)}`;
  const words = layers.map((L, l) => describeSplice(base, { ...L.splice, ops: rew[l]! }));
  const said = (l: number, i: number) => words[l]![i] ?? '';

  // ---- 5. what each change does, in base terms
  const outsOf = (x: string) => uniq(baseRel.filter((e) => e.from === x && e.to !== x).map((e) => e.to));
  const insOf = (x: string) => uniq(baseRel.filter((e) => e.to === x && e.from !== x).map((e) => e.from));
  const D: Desc[] = [];
  layers.forEach((_, l) => rew[l]!.forEach((op, i) => {
    if (!op || typeof op !== 'object') return;
    const ownIds = new Set(props[l]!.map((p) => canon[l]!.get(p.id) ?? p.id));
    const r = (ref: unknown) => { if (!isStr(ref)) return null; if (ownIds.has(ref)) return ref; const x = resolveNodeRef(base, ref); return x.id && (x.match === 'id' || x.match === 'label') ? x.id : null; };
    const d: Desc = { l, i, op, words: said(l, i), uses: [] };
    const nn = (ids: (string | null)[]) => ids.filter((x): x is string => !!x);
    switch (op.op) {
      case 'add': {
        d.made = isStr(op.node?.id) ? op.node.id : undefined; d.label = op.node?.label;
        if (Array.isArray(op.between)) { const a = r(op.between[0]), b = r(op.between[1]); d.uses = nn([a, b]); if (a && b) { d.into = [a, b]; d.near = { rel: 'front', x: b }; } }
        else if (op.before !== undefined) { const x = r(op.before); d.uses = nn([x]); if (x) { d.near = { rel: 'front', x }; const c = baseIds.has(x) ? insOf(x) : []; if (c.length === 1) d.into = [c[0]!, x]; } }
        else if (op.after !== undefined) { const x = r(op.after); d.uses = nn([x]); if (x) { d.near = { rel: 'behind', x }; const c = baseIds.has(x) ? outsOf(x) : []; if (c.length === 1) d.into = [x, c[0]!]; } }
        else if (op.attach) { const x = r(op.attach.to); d.uses = nn([x]); if (x) d.near = { rel: op.attach.dir === 'in' ? 'called' : 'calls', x }; }
        break;
      }
      case 'connect': case 'disconnect': { const a = r(op.from), b = r(op.to); d.uses = nn([a, b]); if (a && b) d.pair = [a, b]; break; }
      case 'remove': case 'rename': if (op.group !== undefined) { d.group = op.group; break; } d.node = r(op.node) ?? undefined; break;
      case 'move': d.node = r(op.node) ?? undefined; break;
      case 'group': {
        d.group = isStr(op.group?.id) ? op.group.id : undefined; d.groupLabel = gpropAt(l, i)?.label ?? op.group?.label;
        if (op.first && typeof op.first === 'object') { d.made = isStr(op.first.id) ? op.first.id : undefined; d.label = op.first.label; }
        if (op.attach) { const x = r(op.attach.to); d.uses = nn([x]); if (x) d.near = { rel: op.attach.dir === 'in' ? 'called' : 'calls', x }; }
        break;
      }
      case 'replace': {
        d.node = r(op.node) ?? undefined;
        if (isStr(op.with)) { d.with = r(op.with) ?? undefined; d.uses = nn([d.with ?? null]); }
        else { d.with = d.made = op.with?.id; d.label = op.with?.label; if (d.node) d.near = { rel: 'instead', x: d.node }; }
        break;
      }
    }
    D.push(d);
  }));
  const nearWords = (d: Desc) => {
    const n = d.near;
    if (!n) return 'on its own';
    return n.rel === 'front' ? `in front of ${lbl(n.x)}` : n.rel === 'behind' ? `behind ${lbl(n.x)}` : n.rel === 'calls' ? `calling ${lbl(n.x)}` : n.rel === 'called' ? `called by ${lbl(n.x)}` : `in place of ${lbl(n.x)}`;
  };

  // ---- 6. what the combination shows (live relationships; a replaced node's references go to its replacement)
  const liveOf = (r: SpliceResult) => {
    const has = new Set(r.model.nodes.filter((n) => r.marks.nodes[n.id] !== 'removed').map((n) => n.id));
    const gone = (k: string) => r.marks.edges[k] === 'removed' || r.marks.edges[k] === 'rerouted';
    const edges = r.model.edges.filter((e) => !isImport(e) && !gone(pairKey(e.from, e.to)) && has.has(e.from) && has.has(e.to));
    return { has, edges, keys: new Set(edges.map((e) => pairKey(e.from, e.to))), proposed: new Set(r.model.nodes.filter((n) => r.marks.nodes[n.id] === 'proposed').map((n) => n.id)) };
  };
  const C = liveOf(result);
  const through = (r: SpliceResult, x: string) => { let y = x; for (let n = 0; n < 16 && r.marks.replaced[y]; n++) y = r.marks.replaced[y]!; return y; };
  /** a → b still holds in the combination: the relationship, or a path through proposed nodes only (routed through them). */
  const holds = (a: string, b: string) => {
    if (C.keys.has(pairKey(a, b))) return true;
    const seen = new Set([a]), q = [a];
    while (q.length) {
      const x = q.shift()!;
      for (const e of C.edges) if (e.from === x && !seen.has(e.to)) { if (e.to === b) return true; if (C.proposed.has(e.to)) { seen.add(e.to); q.push(e.to); } }
    }
    return false;
  };
  /** The layer and change behind a change of the combined splice. */
  const byOp = (k: number | undefined) => (k === undefined || k < 0 ? null : main.origin[k] ?? null);
  const why = (at: { layer: number; index: number } | null) => (at ? `${titles[at.layer]} ${says(said(at.layer, at.index))}` : '');

  // ---- 7. what it finds
  const issues: SpliceConflict[] = [];
  const index = new Map<string, SpliceConflict>();
  /** The issue about a change (`layer:index`), so a change that builds on it is said there. */
  const byChange = new Map<string, SpliceConflict>();
  const coveredOps = new Set<string>(), coveredNodes = new Set<string>(), coveredPairs = new Set<string>();
  const cover = (ds: Desc[], nodes: string[] = [], ps: string[] = []) => { for (const d of ds) coveredOps.add(`${d.l}:${d.i}`); nodes.forEach((n) => coveredNodes.add(n)); ps.forEach((p) => coveredPairs.add(p)); };
  const part = (d: Desc, does: string): ConflictPart => ({ layer: d.l, title: titles[d.l]!, does: [does], ops: [d.i] });
  const partAt = (at: { layer: number; index: number }): ConflictPart => ({ layer: at.layer, title: titles[at.layer]!, does: [says(said(at.layer, at.index))], ops: [at.index] });
  const groupOf = (k: SpliceIssueKind): SpliceIssueGroup => (k === 'lost' || k === 'dangling' ? 'consequence' : k);
  /** One issue per key: a second pair on the same thing joins it (its layers and parts). */
  const add = (key: string, c: Omit<SpliceConflict, 'group'> & { group?: SpliceIssueGroup }) => {
    const had = index.get(key);
    if (had) {
      for (const p of c.parts) {
        const q = p.layer >= 0 ? had.parts.find((x) => x.layer === p.layer) : undefined;
        if (!q) had.parts.push(p);
        else p.does.forEach((w, k) => { if (!q.does.includes(w)) { q.does.push(w); q.ops.push(p.ops[k] ?? p.ops[0]!); } });
      }
      had.parts.sort((a, b) => a.layer - b.layer);
      had.layers = uniq([...had.layers, ...c.layers]).sort((a, b) => a - b);
      had.nodes = uniq([...had.nodes, ...c.nodes]); had.pairs = uniq([...had.pairs, ...c.pairs]);
      if (had.kind === 'conflict' && had.parts.length > 2) had.message = `${and(had.parts.map((p) => p.title))} disagree about ${had.subject}`;
      return had;
    }
    const full = { ...c, group: c.group ?? groupOf(c.kind), layers: uniq(c.layers).sort((a, b) => a - b), parts: [...c.parts].sort((a, b) => a.layer - b.layer) } as SpliceConflict;
    index.set(key, full); issues.push(full);
    if (c.op) byChange.set(`${c.op.layer}:${c.op.index}`, full);
    return full;
  };
  /** What a node ended up as in the combination. */
  const nodeNow = (id: string) => {
    const y = through(result, id);
    if (y !== id && C.has.has(y)) return `${lbl(id)} is replaced by ${lbl(y)}`;
    if (!C.has.has(id)) return `${lbl(id)} is gone`;
    const b = base.nodes.find((n) => n.id === id), c = result.model.nodes.find((n) => n.id === id)!;
    if (!b) return `${lbl(id)} is proposed`;
    const now = [...((c.label ?? c.id) !== (b.label ?? b.id) ? [`it is called ${c.label}`] : []), ...((c.group ?? '') !== (b.group ?? '') ? [`it is in ${c.group}`] : [])];
    return now.length ? and(now) : 'it stays as it is';
  };
  const both = (a: string, b: string) => [pairKey(a, b), pairKey(b, a)];
  const sameRel = (p: [string, string] | undefined, q: [string, string] | undefined) => !!p && !!q && ((p[0] === q[0] && p[1] === q[1]) || (p[0] === q[1] && p[1] === q[0]));
  /** a → (proposed nodes) → b, as the combination has it. */
  const chain = (a: string, b: string): string => {
    const path = [a];
    let x = a;
    for (let n = 0; n < 8; n++) {
      const e = C.edges.find((e2) => e2.from === x && C.proposed.has(e2.to) && !path.includes(e2.to));
      if (!e) break;
      path.push(e.to); x = e.to;
    }
    if (C.keys.has(pairKey(x, b))) path.push(b); else if (path.length === 1) return `${pw(a, b)} is gone`;
    return path.map(lbl).join(' → ');
  };
  /** What became of a change that needed a node another splice removed. */
  const hasGroup = (g: string | undefined) => !!g && !!result.model.groups?.some((x) => x.id === g);
  const lostWords = (y: Desc, cause: string): { kind: 'lost' | 'dangling'; text: string } => {
    if (y.op.op === 'group') {
      if (!hasGroup(y.group)) return { kind: 'lost', text: `The ${y.groupLabel} group is not added, because ${cause}` };
      const dir = y.op.attach?.dir ?? 'out';
      return { kind: 'dangling', text: dir === 'in' ? `Nothing reaches the ${y.groupLabel} group any more, because ${cause}` : `The ${y.groupLabel} group reaches nothing any more, because ${cause}` };
    }
    if (y.made) {
      if (!C.has.has(y.made)) return { kind: 'lost', text: `${y.label} is not added, because ${cause}` };
      const A = liveOf(alone[y.l]!), aIn = A.edges.some((e) => e.to === y.made), aOut = A.edges.some((e) => e.from === y.made);
      const cIn = C.edges.some((e) => e.to === y.made), cOut = C.edges.some((e) => e.from === y.made);
      const miss = [...(aOut && !cOut ? [`${lbl(y.made)} has nothing behind it`] : []), ...(aIn && !cIn ? [`nothing reaches ${lbl(y.made)} any more`] : [])];
      if (miss.length) return { kind: 'dangling', text: `${cap(and(miss))}, because ${cause}` };
      return { kind: 'lost', text: `${y.label} loses its place, because ${cause}` };
    }
    if (y.pair) return { kind: 'lost', text: `${pw(...y.pair)} disappears because ${cause}` };
    return { kind: 'lost', text: `“${y.words}” is lost, because ${cause}` };
  };
  /** Other splices' changes that take away what a proposal of layer l needs. */
  const causeDescs = (l: number, d: Desc) => D.filter((x) => x.l !== l && ((x.node && d.uses.includes(x.node) && (x.op.op === 'remove' || x.op.op === 'replace')) || (x.op.op === 'disconnect' && x.pair && d.into && sameRel(x.pair, d.into))));

  // (a) agreed: one proposal, from two splices or more
  for (const g of groups) {
    if (g.members.length < 2) continue;
    const ds = g.members.map((m) => D.find((d) => d.l === m.l && d.i === m.i)).filter((d): d is Desc => !!d);
    if (ds.length < 2) continue;
    const w = ds[0]!.words, who = and(ds.map((d) => titles[d.l]!));
    const nodes = [ds[0]!.made ?? ds[0]!.node].filter((x): x is string => !!x && result.model.nodes.some((n) => n.id === x));
    const ps = ds[0]!.pair ? both(...ds[0]!.pair).filter((k) => result.model.edges.some((e) => pairKey(e.from, e.to) === k)) : [];
    add(`agreed|${g.sig}`, { kind: 'agreed', layers: ds.map((d) => d.l), nodes, pairs: ps, subject: w, message: `${who} agree: ${w}`,
      parts: ds.map((d) => part(d, says(d.words))), result: `Combined: shown once, agreed by ${who}` });
  }
  // (b) two different proposals with one name
  for (const p of pairs) {
    const da = D.find((d) => d.l === p.a.l && d.i === p.a.i), db = D.find((d) => d.l === p.b.l && d.i === p.b.i);
    const ga = agreedOf(p.a.l, p.a.i);
    if (!da || !db || (ga !== undefined && ga === agreedOf(p.b.l, p.b.i))) continue;
    const name = p.a.label;
    if (p.a.group) {
      const ga = canonG[p.a.l]!.get(p.a.id) ?? p.a.id, gb = canonG[p.b.l]!.get(p.b.id) ?? p.b.id;
      const inG = (g: string) => result.model.nodes.filter((m) => m.group === g).map((m) => m.id);
      const where = (d: Desc) => (d.near ? nearWords(d) : 'on its own');
      const glbl = (g: string) => result.model.groups?.find((z) => z.id === g)?.label ?? g;
      if (p.unified) add(`same|${p.key}`, { kind: 'same-name', group: 'same', layers: [p.a.l, p.b.l], nodes: inG(ga), pairs: [], subject: `One ${name} group`, same: { key: p.key, unified: true },
        message: `${titles[p.a.l]}'s and ${titles[p.b.l]}'s ${name} groups are treated as the same (in this combination only)`,
        parts: [part(da, `proposes a ${name} group ${where(da)}`), part(db, `proposes a ${name} group ${where(db)}`)],
        result: `Combined: one ${name} group, with what both put in it. Recorded in this combination, not in either splice` });
      else add(`same|${p.key}`, { kind: 'same-name', layers: [p.a.l, p.b.l], nodes: [...inG(ga), ...inG(gb)], pairs: [], subject: `Two different ${name} groups`, same: { key: p.key, unified: false },
        message: `Two different ${name} groups, one in ${titles[p.a.l]} (${where(da)}) and one in ${titles[p.b.l]} (${where(db)}). Same thing?`,
        parts: [part(da, `proposes one ${where(da)}`), part(db, `proposes one ${where(db)}`)],
        result: `Combined: two groups, “${glbl(ga)}” and “${glbl(gb)}”. If they are one group, treat them as the same` });
      continue;
    }
    const ida = canon[p.a.l]!.get(p.a.id) ?? p.a.id, idb = canon[p.b.l]!.get(p.b.id) ?? p.b.id;
    if (p.unified) {
      add(`same|${p.key}`, { kind: 'same-name', group: 'same', layers: [p.a.l, p.b.l], nodes: [ida], pairs: [], subject: `One ${name}`, same: { key: p.key, unified: true },
        message: `${titles[p.a.l]}'s and ${titles[p.b.l]}'s ${name} are treated as the same (in this combination only)`,
        parts: [part(da, `proposes ${name} ${nearWords(da)}`), part(db, `proposes ${name} ${nearWords(db)}`)],
        result: `Combined: one ${name}, ${and(uniq([nearWords(da), nearWords(db)]))}. Recorded in this combination, not in either splice` });
    } else {
      add(`same|${p.key}`, { kind: 'same-name', layers: [p.a.l, p.b.l], nodes: [ida, idb].filter((x) => C.has.has(x)), pairs: [], subject: `Two different ${plur(name)}`, same: { key: p.key, unified: false },
        message: `Two different ${plur(name)}, one in ${titles[p.a.l]} (${nearWords(da)}) and one in ${titles[p.b.l]} (${nearWords(db)}). Same thing?`,
        parts: [part(da, `proposes one ${nearWords(da)}`), part(db, `proposes one ${nearWords(db)}`)],
        result: `Combined: two cards, “${lbl(ida)}” and “${lbl(idb)}”. If they are one thing, treat them as the same` });
    }
  }
  // (c) change against change, both ways round (so the words don't depend on the order)
  for (const x of D) for (const y of D) {
    if (x.l === y.l) continue;
    const gx = agreedOf(x.l, x.i);
    if (gx !== undefined && gx === agreedOf(y.l, y.i)) continue;
    const xo = x.op.op, yo = y.op.op;
    if (x.l < y.l) {
      // two ways of changing one node
      if (x.node && x.node === y.node && ((xo === 'rename' && yo === 'rename' && x.op.label.trim() !== (y.op as { label: string }).label.trim()) || (xo === 'move' && yo === 'move' && x.op.group !== (y.op as { group: string }).group) || (xo === 'replace' && yo === 'replace' && x.with !== y.with))) {
        const n = x.node, w = (d: Desc) => (d.op.op === 'rename' ? `renames it to ${d.op.label}` : d.op.op === 'move' ? `moves it into ${d.op.group}` : `replaces it with ${lbl(d.with ?? '')}`);
        add(`conflict|n:${n}|${xo}`, { kind: 'conflict', layers: [x.l, y.l], nodes: [n], pairs: [], subject: lbl(n), message: `${titles[x.l]} and ${titles[y.l]} disagree about ${lbl(n)}`, parts: [part(x, w(x)), part(y, w(y))], result: `Combined: ${nodeNow(n)}` });
        cover([x, y], [n]);
      }
      // two names for one group
      if (xo === 'rename' && yo === 'rename' && x.group && x.group === y.group && x.op.label.trim() !== (y.op as { label: string }).label.trim()) {
        const g = x.group, gl = base.groups?.find((z) => z.id === g)?.label ?? g, now = result.model.groups?.find((z) => z.id === g)?.label ?? g;
        add(`conflict|g:${g}|rename`, { kind: 'conflict', layers: [x.l, y.l], nodes: result.model.nodes.filter((m) => m.group === g).map((m) => m.id).slice(0, 12), pairs: [], subject: `the ${gl} group`, message: `${titles[x.l]} and ${titles[y.l]} disagree about the ${gl} group`,
          parts: [part(x, `renames it to ${x.op.label}`), part(y, `renames it to ${(y.op as { label: string }).label}`)], result: `Combined: it is called ${now}` });
        cover([x, y]);
      }
      // two different things into one relationship
      if (x.into && y.into && sameRel(x.into, y.into) && x.made !== y.made) {
        const [a, b] = x.into;
        add(`conflict|p:${pairKey(a, b)}|into`, { kind: 'conflict', layers: [x.l, y.l], nodes: uniq([x.made, y.made].filter((v): v is string => !!v && C.has.has(v))), pairs: both(a, b), subject: pw(a, b),
          message: `${titles[x.l]} and ${titles[y.l]} both put something between ${lbl(a)} and ${lbl(b)}`,
          parts: [part(x, `routes it through ${x.label}`), part(y, `routes it through ${y.label}`)], result: `Combined: ${chain(a, b)}` });
        cover([x, y], [], both(a, b));
      }
      // one adds the relationship the other takes away
      if (x.pair && y.pair && x.pair[0] === y.pair[0] && x.pair[1] === y.pair[1] && ((xo === 'connect' && yo === 'disconnect') || (xo === 'disconnect' && yo === 'connect'))) {
        const [a, b] = x.pair, k = pairKey(a, b);
        add(`conflict|p:${k}|cd`, { kind: 'conflict', layers: [x.l, y.l], nodes: [], pairs: [k], subject: pw(a, b), message: `${titles[x.l]} and ${titles[y.l]} disagree about ${pw(a, b)}`,
          parts: [part(x, xo === 'connect' ? 'connects them' : 'removes it'), part(y, yo === 'connect' ? 'connects them' : 'removes it')], result: `Combined: ${C.keys.has(k) ? 'it is there' : 'it is gone'}` });
        cover([x, y], [], [k]);
      }
      // one removes what the other replaces
      if (x.node && x.node === y.node && ((xo === 'remove' && yo === 'replace') || (xo === 'replace' && yo === 'remove'))) {
        const n = x.node, w = (d: Desc) => (d.op.op === 'remove' ? 'removes it' : `replaces it with ${lbl(d.with ?? '')}`);
        add(`conflict|n:${n}|rr`, { kind: 'conflict', layers: [x.l, y.l], nodes: [n, ...[x.with, y.with].filter((v): v is string => !!v && C.has.has(v))], pairs: [], subject: lbl(n), message: `${titles[x.l]} and ${titles[y.l]} disagree about ${lbl(n)}`, parts: [part(x, w(x)), part(y, w(y))], result: `Combined: ${nodeNow(n)}` });
        cover([x, y], [n]);
      }
    }
    // (every ordered pair) x takes out a node y renames or moves
    if (x.node && (xo === 'remove' || xo === 'replace') && y.node === x.node && (yo === 'rename' || yo === 'move')) {
      const n = x.node;
      add(`conflict|n:${n}|gone`, { kind: 'conflict', layers: [x.l, y.l], nodes: [n], pairs: [], subject: lbl(n), message: `${titles[Math.min(x.l, y.l)]} and ${titles[Math.max(x.l, y.l)]} disagree about ${lbl(n)}`,
        parts: [part(x, xo === 'remove' ? 'removes it' : `replaces it with ${lbl(x.with ?? '')}`), part(y, y.op.op === 'rename' ? `renames it to ${y.op.label}` : y.op.op === 'move' ? `moves it into ${y.op.group}` : '')], result: `Combined: ${nodeNow(n)}` });
      cover([x, y], [n]);
    }
    // x disconnects the relationship y puts a node into
    if (xo === 'disconnect' && x.pair && y.into && sameRel(x.pair, y.into)) {
      const [a, b] = x.pair, k = pairKey(a, b), there = !!y.made && C.has.has(y.made);
      add(`conflict|p:${k}|dx`, { kind: 'conflict', layers: [x.l, y.l], nodes: there ? [y.made!] : [], pairs: both(a, b), subject: pw(a, b), message: `${titles[Math.min(x.l, y.l)]} and ${titles[Math.max(x.l, y.l)]} disagree about ${pw(a, b)}`,
        parts: [part(x, 'removes it'), part(y, `routes it through ${y.label}`)], result: `Combined: ${there ? chain(a, b) : `it is gone, and ${y.label} is not added`}` });
      cover([x, y], y.made ? [y.made] : [], both(a, b));
    }
    // x removes a node y needs: y's change is lost (or its proposal left dangling)
    if (xo === 'remove' && x.node && yo !== 'disconnect' && yo !== 'remove' && y.uses.includes(x.node)) {
      const n = x.node, subj = y.made ? (y.label ?? lbl(y.made)) : y.pair ? pw(...y.pair) : `“${y.words}”`;
      const res = lostWords(y, `${titles[x.l]} ${says(x.words)}`);
      const inG = yo === 'group' && y.group ? result.model.nodes.filter((m) => m.group === y.group && C.has.has(m.id)).map((m) => m.id) : [];
      add(`lost|${y.l}:${y.i}`, { kind: res.kind, layers: [x.l, y.l], op: { layer: y.l, index: y.i }, nodes: uniq([n, ...(y.made && C.has.has(y.made) ? [y.made] : []), ...inG]), pairs: y.pair && C.keys.has(pairKey(...y.pair)) ? [pairKey(...y.pair)] : [], subject: yo === 'group' ? `The ${y.groupLabel} group` : subj,
        message: res.text, parts: [part(y, says(y.words)), part(x, `removes ${lbl(n)}`)], result: `Combined: ${res.text}` });
      // (the group's cards were placed by its relationship: said here, not once more each)
      cover([y], [...(y.made ? [y.made] : []), ...inG, ...(yo === 'group' && y.group ? (alone[y.l]!.model.nodes.filter((m) => m.group === canonG[y.l]!.get(y.group!) || m.group === y.group).map((m) => m.id)) : [])], y.pair ? [pairKey(...y.pair)] : []);
    }
  }
  // (d) follows: changes that name a node another splice replaced now apply to its replacement (one note per splice and replace)
  for (const x of D) {
    if (x.op.op !== 'replace' || !x.node || !x.with) continue;
    const X = x.node, Y = x.with;
    for (let l = 0; l < N; l++) {
      if (l === x.l) continue;
      const ds = D.filter((d) => d.l === l && d.uses.includes(X) && ['add', 'connect', 'disconnect'].includes(d.op.op) && agreedOf(d.l, d.i) === undefined && !coveredOps.has(`${d.l}:${d.i}`));
      if (!ds.length) continue;
      const clauses = ds.map((d) => {
        if (d.op.op === 'add') { const r = d.near?.x === X ? d.near.rel : d.into?.[1] === X ? 'front' : 'behind'; return `${d.label} now ${r === 'front' ? 'fronts' : r === 'calls' ? 'calls' : 'is called by'} ${lbl(Y)}`; }
        if (d.op.op === 'connect' && d.pair) return d.pair[1] === X ? `${pw(d.pair[0], X)} now goes to ${lbl(Y)}` : `${pw(X, d.pair[1])} now comes from ${lbl(Y)}`;
        if (d.op.op === 'disconnect' && d.pair) { const other = d.pair[0] === X ? d.pair[1] : d.pair[0]; return `${lbl(other)} doesn't reach ${lbl(Y)} directly`; }
        return `“${d.words}” now applies to ${lbl(Y)}`;
      });
      const nodes = uniq([Y, ...ds.map((d) => d.made).filter((v): v is string => !!v)]).filter((v) => C.has.has(v));
      const ps = ds.flatMap((d) => (d.made ? [pairKey(d.made, Y), pairKey(Y, d.made)] : d.pair ? [pairKey(d.pair[0] === X ? Y : d.pair[0], d.pair[1] === X ? Y : d.pair[1])] : [])).filter((k) => C.keys.has(k));
      add(`follows|${x.l}:${x.i}|${l}`, { kind: 'follows', layers: [l, x.l], nodes, pairs: uniq(ps), subject: cap(clauses[0]!),
        message: `${titles[l]}'s ${clauses[0]}, which replaced ${lbl(X)}${clauses.length > 1 ? `, and ${and(clauses.slice(1))}` : ''}`,
        parts: [{ layer: l, title: titles[l]!, does: ds.map((d) => says(d.words)), ops: ds.map((d) => d.i) }, part(x, `replaces ${lbl(X)} with ${lbl(Y)}`)],
        result: `Combined: ${and(clauses)}` });
    }
  }
  // (e) against each splice on its own: a proposal left dangling or not added, a relationship lost, a removal undone
  layers.forEach((_, l) => {
    const A = alone[l]!, AL = liveOf(A);
    for (const id of AL.proposed) {
      if (A.marks.placeholders?.[id]) continue;
      const d = D.find((x) => x.l === l && x.made === id);
      if (!d || coveredNodes.has(id) || coveredOps.has(`${l}:${d.i}`)) continue;
      if (!C.has.has(id)) {
        const k = combIndex(l, d.i), w = k >= 0 ? result.warnings.find((x) => x.op === k) : undefined;
        const cs = causeDescs(l, d);
        const text = `${d.label} is not added${cs.length ? `, because ${and(cs.map((x) => `${titles[x.l]} ${says(x.words)}`))}` : w ? `: ${w.message}` : ''}`;
        add(`lost|${l}:${d.i}`, { kind: 'lost', layers: uniq([l, ...cs.map((x) => x.l)]), op: { layer: l, index: d.i }, nodes: [], pairs: [], subject: d.label ?? lbl(id), message: text, parts: [part(d, says(d.words)), ...cs.map((x) => part(x, says(x.words)))], result: `Combined: ${text}` });
        cover([d], [id]);
        continue;
      }
      // sides it had on its own and has no more
      const lost: string[] = [], who: { layer: number; index: number }[] = [];
      for (const side of ['in', 'out'] as const) {
        const mine = AL.edges.filter((e) => (side === 'out' ? e.from === id : e.to === id));
        if (!mine.length || C.edges.some((e) => (side === 'out' ? e.from === id : e.to === id))) continue;
        lost.push(side === 'out' ? `${lbl(id)} has nothing behind it` : `nothing reaches ${lbl(id)} any more`);
        for (const e of mine) {
          const other = side === 'out' ? e.to : e.from, k = side === 'out' ? pairKey(id, through(result, other)) : pairKey(through(result, other), id);
          const at = byOp(result.trace.retired[k] ?? result.trace.retired[pairKey(e.from, e.to)] ?? result.trace.removed[other]);
          if (at && at.layer !== l) who.push(at);
        }
      }
      if (!lost.length) continue;
      const causes = uniq(who.map((w) => `${w.layer}:${w.index}`)).map((s) => { const [a, b] = s.split(':').map(Number); return { layer: a!, index: b! }; });
      const text = `${cap(and(lost))}${causes.length ? `, because ${and(causes.map(why))}` : ''}`;
      add(`dangling|${id}`, { kind: 'dangling', layers: uniq([l, ...causes.map((c) => c.layer)]), op: { layer: l, index: d.i }, nodes: [id], pairs: [], subject: lbl(id), message: text,
        parts: [part(d, says(d.words)), ...causes.map(partAt)], result: `Combined: ${text}` });
      cover([d], [id]);
    }
    // its proposed relationships that the combination doesn't have (not even through proposed nodes)
    for (const e of AL.edges) {
      const k0 = pairKey(e.from, e.to);
      if (A.marks.edges[k0] !== 'proposed' || coveredPairs.has(k0)) continue;
      const a = through(result, e.from), b = through(result, e.to);
      if (!C.has.has(a) || !C.has.has(b) || (coveredNodes.has(e.from) || coveredNodes.has(e.to))) continue;
      if (holds(a, b)) continue;
      const src = D.find((d) => d.l === l && ((d.pair && d.pair[0] === e.from && d.pair[1] === e.to) || (d.made && (d.made === e.from || d.made === e.to))));
      if (src && coveredOps.has(`${l}:${src.i}`)) continue;
      const at = byOp(result.trace.retired[pairKey(a, b)] ?? result.trace.retired[k0]);
      const other = at && at.layer !== l ? at : null;
      const text = `${pw(a, b)} disappears${other ? ` because ${why(other)}` : ''}`;
      add(`lost|p:${k0}`, { kind: 'lost', layers: uniq([l, ...(other ? [other.layer] : [])]), ...(src ? { op: { layer: l, index: src.i } } : {}), nodes: [a, b], pairs: [], subject: pw(a, b), message: text,
        parts: [...(src ? [part(src, says(src.words))] : []), ...(other ? [partAt(other)] : [])], result: `Combined: ${text}` });
      coveredPairs.add(k0);
      if (src) coveredOps.add(`${l}:${src.i}`);
    }
    // what it removed that the combination has again
    for (const [k, m] of Object.entries(A.marks.edges)) {
      if (m !== 'removed' || coveredPairs.has(k) || !C.keys.has(k)) continue;
      const [f, t] = k.split('->') as [string, string];
      if (A.marks.nodes[f] === 'removed' || A.marks.nodes[t] === 'removed') continue;
      const j = main.origin.findIndex((x, n) => x.layer !== l && (result.marks.touched[n]?.edges ?? []).includes(k));
      const at = j >= 0 ? main.origin[j]! : null;
      const src = D.find((d) => d.l === l && d.pair && pairKey(...d.pair) === k);
      if (src && coveredOps.has(`${l}:${src.i}`)) continue;
      const text = `${pw(f, t)} is back${at ? ` because ${why(at)}` : ''}`;
      add(`lost|p:${k}`, { kind: 'lost', layers: uniq([l, ...(at ? [at.layer] : [])]), ...(src ? { op: { layer: l, index: src.i } } : {}), nodes: [], pairs: [k], subject: pw(f, t), message: text,
        parts: [...(src ? [part(src, says(src.words))] : []), ...(at ? [partAt(at)] : [])], result: `Combined: ${text}` });
      coveredPairs.add(k);
    }
  });
  // (f) a change that warns once combined but not on its own, that nothing above explains
  const warnings: CombinedSplices['warnings'] = [];
  for (const w of result.warnings) {
    if (w.op < 0) continue;
    const at = main.origin[w.op];
    if (!at) continue;
    if (alone[at.layer]!.warnings.some((x) => x.op === at.index && x.message === w.message)) { warnings.push({ layer: at.layer, index: at.index, message: w.message }); continue; }
    if (coveredOps.has(`${at.layer}:${at.index}`)) continue;
    const d = D.find((x) => x.l === at.layer && x.i === at.index);
    // what it wanted holds anyway: a disconnect whose relationship is gone, a remove whose node is gone
    if (d?.op.op === 'disconnect' && d.pair && !C.keys.has(pairKey(through(result, d.pair[0]), through(result, d.pair[1])))) continue;
    if (d?.op.op === 'remove' && d.node && !C.has.has(d.node)) continue;
    // a change that builds on one already found lost: said there
    const host = (alone[at.layer]!.marks.byOp[at.index] ?? []).map((j) => byChange.get(`${at.layer}:${j}`)).find((x) => !!x);
    if (host) {
      const p = host.parts.find((x) => x.layer === at.layer);
      if (p) { p.does.push(`so “${said(at.layer, at.index)}” no longer applies either`); p.ops.push(at.index); }
      coveredOps.add(`${at.layer}:${at.index}`);
      continue;
    }
    const t = result.marks.touched[w.op]!, skipped = !(t.nodes.length || t.edges.length);
    const text = `“${said(at.layer, at.index)}” ${skipped ? 'no longer applies' : 'applies with a warning'}: ${w.message}`;
    add(`lost|${at.layer}:${at.index}`, { kind: 'lost', layers: [at.layer], op: at, nodes: d?.made && C.has.has(d.made) ? [d.made] : [], pairs: [], subject: `“${said(at.layer, at.index)}”`, message: `${titles[at.layer]}: ${text}`,
      parts: [{ layer: at.layer, title: titles[at.layer]!, does: [`${says(said(at.layer, at.index))}: ${skipped ? 'skipped once combined' : 'warns once combined'}`], ops: [at.index] }], result: `Combined: ${text}` });
    coveredOps.add(`${at.layer}:${at.index}`);
  }
  // (g) the order: what the other order gives, when it gives something else
  let other: CombinedSplices['other'] = null;
  if (back) {
    const B = liveOf(back.result);
    const nodeSig = (r: SpliceResult, L2: ReturnType<typeof liveOf>) => new Map([...L2.has].map((id) => { const n = r.model.nodes.find((x) => x.id === id)!; return [id, `${n.label ?? id}|${n.group ?? ''}`] as const; }));
    const na = nodeSig(result, C), nb = nodeSig(back.result, B);
    const nodesA = [...na.keys()].filter((k) => !nb.has(k)), nodesB = [...nb.keys()].filter((k) => !na.has(k));
    const onlyNode = new Set([...nodesA, ...nodesB]), implied = (k: string) => k.split('->').some((x) => onlyNode.has(x));
    const relsA = [...C.keys].filter((k) => !B.keys.has(k)), relsB = [...B.keys].filter((k) => !C.keys.has(k));
    const saidA = relsA.filter((k) => !implied(k)), saidB = relsB.filter((k) => !implied(k));
    const renamed = [...na.keys()].filter((id) => nb.has(id) && nb.get(id) !== na.get(id));
    const differs = nodesA.length + nodesB.length + relsA.length + relsB.length + renamed.length > 0;
    const ordB = [...fwd].reverse().map((l) => titles[l]!);
    other = { order: ordB, result: back.result, differs };
    if (differs) {
      const list = (xs: string[]) => (xs.length > 4 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : and(xs));
      const rel = (k: string) => pw(...(k.split('->') as [string, string]));
      const as = (r: SpliceResult, id: string) => { const n = r.model.nodes.find((x) => x.id === id)!; return fold(n.label ?? '') !== fold(base.nodes.find((b) => b.id === id)?.label ?? n.label ?? '') ? `${lbl(id)} called ${n.label}` : `${n.label} in ${n.group}`; };
      /** Relationships as chains ("Checkout → Validator → Orders cache → Orders store"), so an order reads as one path. */
      const chains = (ks: string[]) => {
        const es = ks.map((k) => k.split('->') as [string, string]), out: string[][] = [];
        const left = new Set(es.map((_, k) => k));
        while (left.size) {
          const k0 = [...left].find((k) => !es.some((e, j) => left.has(j) && e[1] === es[k]![0])) ?? [...left][0]!;
          left.delete(k0);
          const path = [...es[k0]!];
          for (let more = true; more;) {
            more = false;
            for (const j of left) if (es[j]![0] === path[path.length - 1]) { path.push(es[j]![1]); left.delete(j); more = true; break; }
          }
          out.push(path);
        }
        return out.map((ps) => ps.map(lbl).join(' → '));
      };
      const desc = (ns: string[], rs: string[], noNs: string[], r: SpliceResult) => [`gives ${and([
        ...(ns.length || rs.length ? [list([...ns.map(lbl), ...chains(rs)])] : []),
        ...(noNs.length ? [`no ${list(noNs.map(lbl))}`] : []),
        ...renamed.map((id) => as(r, id)),
      ])}`];
      const dA = desc(nodesA, saidA, nodesB, result), dB = desc(nodesB, saidB, nodesA, back.result);
      const tA = titles.join(', then '), tB = ordB.join(', then ');
      add('order', { kind: 'order', layers: fwd, nodes: [...nodesA, ...renamed], pairs: relsA, subject: 'The order changes the result', message: `The order matters: ${tA} ${and(dA)}; ${tB} ${and(dB)}`,
        parts: [{ layer: -1, title: tA, does: dA, ops: [] }, { layer: -1, title: tB, does: dB, ops: [] }], result: `Shown: ${tA}. ⇄ swaps the order` });
    }
  }
  // conflicts first, then consequences, the order, the questions, the notes
  const rank: Record<SpliceIssueGroup, number> = { conflict: 0, consequence: 1, order: 2, 'same-name': 3, same: 4, follows: 5, agreed: 6 };
  const conflicts = issues.map((c, k) => [c, k] as const).sort((a, b) => rank[a[0].group] - rank[b[0].group] || a[1] - b[1]).map(([c]) => c);
  return { splice, result, origin: main.origin, parts, conflicts, warnings, order: [...titles], other };
}

/** How a stack of splices asks the Stack view to draw it (src/model/stack.ts `StackOpts`): every slice against the real
 *  view (each splice's marks say what it proposes and removes), not against its neighbour; and the marks' words. */
export const SPLICE_STACK_VIEW = {
  diff: 'none',
  words: { proposed: 'not in the code yet', removed: 'ghost: removed or rerouted by the splice', changed: 'renamed or moved by the splice' },
} as const;

export interface SpliceStackOpts {
  /** The first slice: the view without any splice (default title "Real view"). */
  realTitle?: string;
  realSubtitle?: string;
  /** Layers to combine into one more slice at the end (indices into the layers, in order); fewer than two: none. */
  combine?: number[];
  /** Same-name pairs the person said are one thing (`SpliceConflict.same.key`). */
  same?: string[];
}
export type SpliceSliceKind = 'real' | 'splice' | 'combined';
export interface SpliceStack {
  slices: StackSlice[];
  /** What each slice is, and for a splice slice its layer (index into the layers). */
  kinds: { kind: SpliceSliceKind; layer?: number }[];
  combined: CombinedSplices | null;
  /** The combined slice's layers (indices), in order. */
  combine: number[];
}

/** The combined slice's one-line summary: what it found, by group, in the key's words ("⚠ 1 conflict · ⇄ the order
 *  matters · ✓ 1 agreed"). */
export function issueSummary(cs: SpliceConflict[]): string {
  const n = (g: SpliceIssueGroup) => cs.filter((c) => c.group === g).length;
  const W = ISSUE_WORDS;
  const warn = [n('conflict') && plural(n('conflict'), W.conflict.name), n('consequence') && plural(n('consequence'), W.consequence.name)].filter(Boolean);
  return [
    ...(warn.length ? [`⚠ ${warn.join(' · ')}`] : []),
    ...(n('order') ? ['⇄ the order matters'] : []),
    ...(n('same-name') ? [`? ${plural(n('same-name'), 'same name')}`] : []),
    ...(n('same') ? [`= ${n('same')} treated as the same`] : []),
    ...(n('agreed') ? [`✓ ${n('agreed')} agreed`] : []),
    ...(n('follows') ? [`→ ${n('follows')} follow${n('follows') === 1 ? 's' : ''} a replacement`] : []),
  ].join(' · ');
}

/** The slices of a stack of splices: the real view, one per layer (the layer applied over `base`, its marks, its
 *  changes in words, "unsaved" when it isn't saved, a warning when changes no longer apply), and the combination. */
export function spliceStack(base: Model, layers: SpliceLayer[], o: SpliceStackOpts = {}): SpliceStack {
  const slices: StackSlice[] = [{ id: 'real', title: o.realTitle ?? 'Real view', subtitle: o.realSubtitle ?? 'no proposals', model: base, about: ['no proposals: the picture as it is'] }];
  const kinds: SpliceStack['kinds'] = [{ kind: 'real' }];
  layers.forEach((l, i) => {
    const r = applySplice(base, l.splice), n = l.splice.ops.length, ws = r.warnings;
    const lines = describeSplice(base, l.splice);
    slices.push({
      id: `splice:${l.key}`, title: l.title, subtitle: `${plural(n, 'change')} · ${l.unsaved ? 'unsaved' : 'saved'}`, model: r.model,
      marks: { nodes: r.marks.nodes, edges: boardMarks(r).edges }, about: lines, ...(l.unsaved ? { badge: 'unsaved' } : {}),
      ...(ws.length ? { warning: { name: 'no longer applies', text: `⚠ ${plural(ws.length, 'change')} no longer appl${ws.length === 1 ? 'ies' : 'y'}`, details: ws.map((w) => `${w.op >= 0 ? `“${lines[w.op] ?? ''}”: ` : ''}${w.message}`), nodes: [], pairs: [] } } : {}),
    });
    kinds.push({ kind: 'splice', layer: i });
  });
  const combine = uniq((o.combine ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < layers.length));
  let combined: CombinedSplices | null = null;
  if (combine.length >= 2) {
    const ls = combine.map((i) => layers[i]!);
    const c = combineSplices(base, ls, o.same ? { same: o.same } : {});
    combined = c;
    const cs = c.conflicts, n = c.splice.ops.length;
    const warnish = cs.filter((x) => ISSUE_WORDS[x.group].tone !== 'note');
    const lead = ISSUE_WORDS[(warnish[0] ?? cs[0])?.group ?? 'conflict'];
    const items: WarningItem[] = cs.map((x) => {
      const W = ISSUE_WORDS[x.group];
      return {
        title: x.subject, who: x.layers.map((l) => ls[l]!.title), nodes: x.nodes, pairs: x.pairs, name: W.name, sym: W.sym, tone: W.tone, meaning: W.meaning,
        lines: x.parts.map((p) => ({ who: p.title, text: p.does.join('; ') || 'changes it', ...(p.layer >= 0 ? { open: 1 + combine[p.layer]! } : {}) })), result: x.result,
        ...(x.same ? { actions: [{ id: `same:${x.same.key}`, label: x.same.unified ? 'Treat as different' : 'Treat as the same' }] } : {}),
      };
    });
    const lines = describeSplice(base, c.splice);
    slices.push({
      id: 'combined', title: c.splice.title, subtitle: `${plural(n, 'change')} · read-only`, model: c.result.model,
      marks: { nodes: c.result.marks.nodes, edges: boardMarks(c.result).edges }, badge: 'combined',
      about: [`${c.order.join(', then ')}: each one's changes, in that order${c.other?.differs ? ' (the other order gives something else)' : ''}`, ...cs.map((x) => `${ISSUE_WORDS[x.group].sym} ${x.message}`), ...lines],
      ...(cs.length ? {
        warning: {
          name: lead.name, meaning: lead.meaning, text: issueSummary(cs), details: cs.map((x) => x.message), tone: warnish.length ? 'warn' : 'note',
          // only what needs a look is outlined and marked ⚠ on the slice; a note lights when its item is hovered
          nodes: uniq(warnish.flatMap((x) => x.nodes)), pairs: uniq(warnish.flatMap((x) => x.pairs)),
          items,
        },
      } : {}),
    });
    kinds.push({ kind: 'combined' });
  }
  return { slices, kinds, combined, combine: combined ? combine : [] };
}
