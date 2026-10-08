// Lane folding for the sequence plate (docs/KITS.md "The sequence view: folding"). A flow that touched many nodes
// draws many lanes; folding collapses lanes that belong together into one lane the viewer can expand again, so a
// long flow reads at a glance without hiding any participant. Pure (browser and bun) and shape-neutral: the rule reads
// only the model's own structure (parent/fold, groups, categories, kinds) and who called whom in this flow.
//
// The rule, in order of preference (a lane joins at most one unit):
//   (a) what the model already groups: lanes that the model's fold (`parent` + `fold`, from a producer or a curation
//       file's `fold`) draws as one node, or the lanes of a nested curation group (a group with a `parent`). Two or
//       more such lanes fold, named after the parent node or the group.
//   (b) otherwise, sibling leaves: three or more lanes that are called only from the same one lane in this flow, make
//       no calls of their own in this flow, and share a category (or, when they have none, a kind). Named for what they
//       share: "5 stages" (the category's plural, "called by <caller>" as the subtitle), else "<caller>'s 5 steps".
// Never folded: the flow's entry, and any lane a failed call touched (its caller or callee): an error stays in view.
// `auto` folds only when it helps: when the flow has more lanes than fit comfortably across the plate's default width
// (about 1440 px at the default lane pitch), or more than 10. `none` keeps every lane; explicit groups (string[][])
// fold as given, whatever the lane count (the entry and failed lanes still stay out).
import { foldView, type MFlow, type MNode, type MSpan, type Model } from './model';

/** The plate's `fold` option: derive units (`auto`, the default), fold nothing (`none`), or fold these groups of node ids. */
export type SequenceFold = 'auto' | 'none' | string[][];

/** One folded lane: the lanes it stands for, in lane order, and what it is called. */
export interface FoldUnit {
  /** `fold:<first member>`: stable for a model and a flow (view state and stills name it). */
  id: string;
  members: string[];
  /** What the head says: "5 stages", "Checkout's 3 parts", "Pipeline runner's 4 steps". */
  name: string;
  /** The members' shared noun, for words like "5 stages folded" ("stages", "parts", "steps", "lanes"). */
  noun: string;
  /** The line above the head: "called by Pipeline runner", "part of Checkout", "group Storage". */
  sub: string;
  /** Which rule made it. */
  why: 'fold' | 'group' | 'siblings' | 'explicit';
}

/** One recorded call between lanes (from: the caller's node; null when the flow has no entry to start from). */
export interface LaneCall { from: string | null; to: string; err: boolean }

/** A flow's lanes (its entry first, then each node in the order it is first called) and its calls, as the sequence
 *  plate draws them. `keep` narrows them to a plate type's filter (the entry always stays). */
export function flowLanes(flow: MFlow, keep?: Set<string>): { lanes: string[]; calls: LaneCall[] } {
  const all = [...flow.spans].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const byId = new Map(all.map((s) => [s.id, s]));
  const callerOf = (s: MSpan) => (s.parent && byId.has(s.parent) ? byId.get(s.parent)!.node : flow.entry ?? null);
  const spans = keep ? all.filter((s) => keep.has(s.node)) : all;
  const lanes: string[] = [];
  const addLane = (id: string | null) => { if (id && !lanes.includes(id) && (!keep || keep.has(id) || id === flow.entry)) lanes.push(id); };
  addLane(flow.entry ?? null);
  for (const s of spans) { addLane(callerOf(s)); addLane(s.node); }
  const calls = spans.map((s) => { const f = callerOf(s); return { from: f && lanes.includes(f) ? f : null, to: s.node, err: s.status === 'error' }; });
  return { lanes, calls };
}

/** Past this many lanes a flow folds (auto); fewer fit comfortably. */
export const FOLD_MAX_LANES = 10;
/** The plate width the lanes should fit comfortably across, and the lane pitch they'd like (src/model/sequence.ts). */
export const FOLD_COMFORT_W = 1440;
const SIDE = 48, PITCH = 150;
/** How many lanes fit comfortably across a plate `width` px wide. */
export const comfortableLanes = (width = FOLD_COMFORT_W) => Math.max(1, Math.floor((width - 2 * SIDE) / PITCH));

/** A word's plural, for category names ("stage" → "stages", "query" → "queries", "box" → "boxes"). */
export function pluralWord(w: string): string {
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** Is this a valid `fold` option? */
export function isSequenceFold(v: unknown): v is SequenceFold {
  return v === 'auto' || v === 'none' || (Array.isArray(v) && v.every((g) => Array.isArray(g) && g.every((x) => typeof x === 'string' && x)));
}

/** The units a flow's lanes fold into (the rule above). `lanes` and `calls` as `flowLanes` gives them. */
export function foldLanes(model: Model, flow: MFlow, lanes: string[], calls: LaneCall[], fold: SequenceFold = 'auto', o: { width?: number } = {}): FoldUnit[] {
  if (fold === 'none' || lanes.length < 2) return [];
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const node = (id: string): MNode | undefined => byId.get(id);
  const label = (id: string) => node(id)?.label ?? id;
  const order = new Map(lanes.map((id, i) => [id, i]));
  // never folded: the entry, and every lane a failed call touched
  const blocked = new Set<string>([...(flow.entry ? [flow.entry] : []), ...calls.filter((c) => c.err).flatMap((c) => (c.from ? [c.from, c.to] : [c.to]))]);
  const callers = new Map<string, Set<string | null>>();
  for (const c of calls) (callers.get(c.to) ?? callers.set(c.to, new Set()).get(c.to)!).add(c.from);
  const calls0 = new Set(calls.filter((c) => c.from).map((c) => c.from!));
  const taken = new Set<string>();
  const units: FoldUnit[] = [];
  const add = (ids: string[], min: number, name: (m: string[]) => Omit<FoldUnit, 'id' | 'members'>) => {
    const m = [...new Set(ids)].filter((id) => order.has(id) && !blocked.has(id) && !taken.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    if (m.length < min || m.length >= lanes.length) return;
    for (const id of m) taken.add(id);
    units.push({ id: `fold:${m[0]}`, members: m, ...name(m) });
  };
  // what the members share: a category, else the one lane that calls them
  const shared = (m: string[]) => {
    const cats = new Set(m.map((id) => node(id)?.category || null));
    const cat = cats.size === 1 ? [...cats][0] : null;
    const cs = new Set(m.flatMap((id) => [...(callers.get(id) ?? [])]));
    const caller = cs.size === 1 ? [...cs][0] ?? null : null;
    return { cat, caller };
  };
  const named = (m: string[], why: FoldUnit['why']): Omit<FoldUnit, 'id' | 'members'> => {
    const { cat, caller } = shared(m);
    const sub = caller ? `called by ${label(caller)}` : `${m.length} lanes`;
    if (cat) { const noun = pluralWord(cat); return { name: `${m.length} ${noun}`, noun, sub, why }; }
    if (caller) return { name: `${label(caller)}'s ${m.length} steps`, noun: 'steps', sub, why };
    return { name: `${m.length} lanes`, noun: 'lanes', sub, why };
  };

  if (Array.isArray(fold)) {
    for (const g of fold) add(g, 2, (m) => named(m, 'explicit'));
    return units;
  }
  if (lanes.length <= Math.min(FOLD_MAX_LANES, comfortableLanes(o.width))) return [];

  // (a) the model's own fold (parent + fold), then nested curation groups
  const { rep } = foldView(model);
  const byRep = new Map<string, string[]>();
  for (const id of lanes) { const r = rep(id); if (r !== id || lanes.some((x) => x !== id && rep(x) === id)) (byRep.get(r) ?? byRep.set(r, []).get(r)!).push(id); }
  for (const [r, ids] of byRep) add(ids, 2, (m) => ({ name: `${label(r)}'s ${m.length} parts`, noun: 'parts', sub: `part of ${label(r)}`, why: 'fold' }));
  const nested = (model.groups ?? []).filter((g) => g.parent);
  for (const g of nested) add(lanes.filter((id) => node(id)?.group === g.id), 2, (m) => { const n = named(m, 'group'); return { ...n, name: `${g.label ?? g.id} (${m.length})`, sub: `group ${g.label ?? g.id}` }; });

  // (b) sibling leaves: one caller, no calls of their own, a shared category (else kind)
  const sets = new Map<string, string[]>();
  for (const id of lanes) {
    if (taken.has(id) || blocked.has(id) || calls0.has(id)) continue;
    const cs = callers.get(id);
    if (!cs || cs.size !== 1) continue;
    const c = [...cs][0];
    if (!c) continue;
    const n = node(id), k = n?.category ? `cat:${n.category}` : `kind:${n?.kind ?? 'external'}`;
    const key = `${c}\n${k}`;
    (sets.get(key) ?? sets.set(key, []).get(key)!).push(id);
  }
  for (const ids of sets.values()) add(ids, 3, (m) => named(m, 'siblings'));
  return units.sort((a, b) => order.get(a.members[0]!)! - order.get(b.members[0]!)!);
}
