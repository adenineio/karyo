// The Karyo model (docs/MODEL.md): types, merging fragments from any language, and
// reconciling declared / extracted / observed truth into warnings. Pure functions, usable
// from the CLI (scripts/model.ts) and in the browser.
//
// Identity lives here and only here (docs/MODEL.md "Identity"): `pairKey` / `edgeKey` say when two
// edge records are one relationship, `attributeCall` says which relationship a recorded call belongs
// to, `verdict` says what the three sources of truth make of it, and `invariants` fails the build
// when the model breaks any of that. Merge, reconcile, checksFor and every view use these.

/** `proposed`: a what-if from a splice (docs/MODEL.md "Splices"), never from the code. A proposed node or
 *  relationship is an intention: views draw it apart, and reconcile never checks it for drift. */
export type Source = 'declared' | 'extracted' | 'observed' | 'proposed';
/** `type`: a type (a class, struct, record, interface): what data and operations are bundled under one name. */
export type NodeKind = 'service' | 'function' | 'type' | 'store' | 'queue' | 'external' | 'actor' | 'module';
export type EdgeKind = 'calls' | 'reads' | 'writes' | 'publishes' | 'subscribes' | 'imports';

export interface MRef { file: string; line?: number; symbol?: string }
/** A declaration's source, captured by the SDKs from the code itself (`# karyo:` directives, decorators or doc comment included).
 *  `text` is lines `start`..`end` of `file`, verbatim; at most 80 lines, `truncated` when the declaration is longer. */
export interface MCode { file: string; start: number; end: number; lang: string; text: string; truncated?: boolean }
/** `category` is one declared word per node (e.g. tool, store, stage) that views can color or filter by; `tags` are
 *  free-form declared labels (e.g. hot-path). Both come from directives (`category=` `tags=`) or decorators. */
/** `parent`: the node this one is part of (a method's class, a step's process). `fold`: views draw it folded into its parent
 *  (its relationships and recorded calls roll up onto the parent: `foldView`); producers set it (automatic mode folds methods)
 *  and a curation file changes it. `exercised`: set only when a recording watched this node's code in full (a `coverage`
 *  scope): whether it ran. `false` is "not exercised" (it never ran in the recorded runs); absent means nobody can say. */
export interface MNode { id: string; kind: NodeKind; label?: string; summary?: string; group?: string; category?: string; tags?: string[]; module?: string; lang?: string; ref?: MRef; code?: MCode; parent?: string; fold?: boolean; exercised?: boolean; sources: Source[] }
/** One relationship between an ordered pair of nodes (or one import between two modules). A pair the code
 *  declares with several kinds (A reads AND writes B) is still one edge: `kinds` lists them all in canonical
 *  order (only when there are several) and `kind` is the first. `count`: recorded calls attributed to it. */
/** `exercised` (relationships only): set when a recording watched both ends in full: whether the call was seen. */
export interface MEdge { from: string; to: string; kind: EdgeKind; kinds?: EdgeKind[]; label?: string; count?: number; exercised?: boolean; sources: Source[] }
export interface MSpan { id: string; parent: string | null; node: string; label?: string; start: number; end?: number; status?: 'ok' | 'error'; lang?: string; flow?: string; attrs?: Record<string, unknown> }
export interface MFlow { id: string; title?: string; trace: string; entry?: string; spans: MSpan[] }
/** `error`: the model itself is wrong (an identity conflict, or an engine bug): builds and checks fail on it.
 *  `warn`: the code and its docs disagree. `info`: worth knowing. */
export type CheckLevel = 'error' | 'warn' | 'info';
export interface MCheck { level: CheckLevel; code: string; message: string; subject?: string }
/** A named group (nodes name theirs in `group`): its label, and the group it sits in (`parent`), from a curation file. */
export interface MGroup { id: string; label?: string; parent?: string; summary?: string }
/** A recording that watched every call inside `scope` (module / package / id prefixes, dotted), e.g. Python's sys.monitoring
 *  recorder: what lets the model say a node or relationship in scope was "not exercised". `sample` < 1: only that share of
 *  flows was recorded. */
export interface MCoverage { scope: string[]; by?: string; sample?: number }
export interface Model { karyo: 1; project?: string; producers?: { name: string; lang: string; version?: string; at?: string }[]; nodes: MNode[]; edges: MEdge[]; flows: MFlow[]; groups?: MGroup[]; coverage?: MCoverage[]; checks?: MCheck[]; tours?: BuiltTour[] }

// ---- tours (docs/MODEL.md "Tours"): authored walkthroughs, resolved against the code and the recorded flows at build time (src/model/tours.ts).
// Same shapes as src/model/tour-types.ts (the tour plate's contract): keep them in sync.

/** A code excerpt in a tour step. `focus` holds absolute line numbers (within start..end) to highlight. */
export interface BuiltCode extends MCode { focus: number[]; symbol?: string }
export interface BuiltTiming {
  /** Sum of the durations of the matched spans, in milliseconds. */
  ms: number;
  label: string;
  status: 'ok' | 'error';
  /** How many recorded spans were matched (e.g. 2 for a tool called twice). */
  spans: number;
  attrs?: Record<string, unknown>;
}
export interface BuiltStep {
  id: string;
  title: string;
  /** Consecutive steps sharing a group are drawn as one bracketed station group. */
  group?: string;
  /** Markdown-lite prose: paragraphs, `code`, **bold**. */
  text?: string;
  node?: string;
  /** Node ids for the step's mini diagram: the node, then the step's `show` list. */
  show: string[];
  code?: BuiltCode;
  timing?: BuiltTiming;
  source: 'authored' | 'expanded';
}
export interface BuiltTour { id: string; title: string; summary?: string; flow?: string; steps: BuiltStep[] }


// ================================================================== identity
//
// The one definition of "the same thing". Everything that keys, looks up, counts, compares or draws
// nodes and edges goes through these; nothing else builds a key from an id.

/** Relationship kinds in canonical order. A relationship carrying several has the first as its `kind`. */
export const RELATION_KINDS: readonly EdgeKind[] = ['calls', 'reads', 'writes', 'publishes', 'subscribes'];
const EDGE_KINDS: readonly EdgeKind[] = [...RELATION_KINDS, 'imports'];
const KIND_RANK = new Map(EDGE_KINDS.map((k, i) => [k, i]));
const byKind = (a: EdgeKind, b: EdgeKind) => KIND_RANK.get(a)! - KIND_RANK.get(b)!;

/** Node ids (the schema's `id`): dotted words, no spaces, no `>` (so `pairKey` can always be split). */
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
/** Two node ids that fold to the same key look like one name to a reader: an identity conflict. */
export const idFold = (id: string) => id.normalize('NFKC').replace(/\s+/g, '').toLowerCase().replace(/\.{2,}/g, '.').replace(/\.+$/, '');
/** Tag and category spellings that fold to the same key read as one label. */
export const nameFold = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-');

/** The identity of a relationship: its ordered pair. Also the `subject` of every check about it. */
export const pairKey = (from: string, to: string) => `${from}->${to}`;
/** `pairKey` backwards (null when `key` isn't a pair). Ids can't contain `>`, so the first `->` splits it. */
export function parsePairKey(key: string): { from: string; to: string } | null {
  const i = key.indexOf('->');
  return i > 0 && i + 2 < key.length ? { from: key.slice(0, i), to: key.slice(i + 2) } : null;
}
export const isImport = (e: { kind: EdgeKind }) => e.kind === 'imports';
/** The identity of any edge: relationships by ordered pair (whatever their kinds), imports (module →
 *  module, a different layer) by pair too, apart from relationships. */
export const edgeKey = (e: { from: string; to: string; kind: EdgeKind }) => (isImport(e) ? `${pairKey(e.from, e.to)} imports` : pairKey(e.from, e.to));
/** Every kind an edge carries, primary first. */
export const kindsOf = (e: MEdge): EdgeKind[] => (e.kinds?.length ? e.kinds : [e.kind]);

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const SRC_ORDER: Source[] = ['declared', 'extracted', 'observed', 'proposed'];
const sortSources = (s: Source[]) => SRC_ORDER.filter((x) => s.includes(x));
const LABEL_SEP = ' · ';

/** Folds edge records into one edge per `edgeKey`, the same whatever order the records come in:
 *  kinds, sources and labels (sorted, joined with ' · ') add up, counts sum. A record that only says "observed" (a recorded run
 *  sees calls, never reads or writes) confirms the pair's declared kinds instead of adding `calls`. */
export class EdgeFold {
  private acc = new Map<string, { from: string; to: string; imports: boolean; strong: Set<EdgeKind>; weak: Set<EdgeKind>; labels: Set<string>; sources: Set<Source>; count: number; counted: boolean; ex: (boolean | undefined)[] }>();
  /** Edge kinds that aren't in the model format, as found (merge reports them). */
  readonly unknownKinds: { from: string; to: string; kind: string }[] = [];

  add(e: MEdge): string {
    const kinds = kindsOf(e).map((k) => {
      if (KIND_RANK.has(k)) return k;
      this.unknownKinds.push({ from: e.from, to: e.to, kind: String(k) });
      return 'calls' as EdgeKind;
    });
    const imports = e.kind === 'imports';
    const key = imports ? edgeKey(e) : pairKey(e.from, e.to);
    let a = this.acc.get(key);
    if (!a) this.acc.set(key, (a = { from: e.from, to: e.to, imports, strong: new Set(), weak: new Set(), labels: new Set(), sources: new Set(), count: 0, counted: false, ex: [] }));
    const srcs = e.sources ?? [];
    // a recorded run and static analysis only ever see calls: they confirm a pair's declared kinds instead of adding `calls`
    const weak = srcs.length > 0 && srcs.every((s) => s === 'observed' || s === 'extracted');
    for (const k of imports ? (['imports'] as EdgeKind[]) : kinds.filter((k) => k !== 'imports')) (weak ? a.weak : a.strong).add(k);
    if (!imports && !kinds.some((k) => k !== 'imports')) (weak ? a.weak : a.strong).add('calls');
    if (!imports) a.ex.push(e.exercised);
    for (const s of srcs) a.sources.add(s);
    for (const l of (e.label ?? '').split(LABEL_SEP).map((x) => x.trim()).filter(Boolean)) a.labels.add(l);
    if (typeof e.count === 'number') { a.count += e.count; a.counted = true; }
    return key;
  }
  /** A recorded call attributed to `hop` (see `attributeCall`): the relationship is observed once more. */
  observe(hop: Hop) {
    if (!this.acc.has(hop.key)) this.add({ from: hop.from, to: hop.to, kind: 'calls', sources: ['observed'] });
    const a = this.acc.get(hop.key)!;
    a.sources.add('observed'); a.count += 1; a.counted = true;
    if (a.ex.length) a.ex = a.ex.map((x) => (x === undefined ? x : true));
  }
  has(key: string) { return this.acc.has(key); }
  get(key: string): MEdge | undefined { const a = this.acc.get(key); return a && this.edge(a); }
  edges(): MEdge[] { return [...this.acc.values()].map((a) => this.edge(a)); }
  private edge(a: NonNullable<ReturnType<EdgeFold['acc']['get']>>): MEdge {
    const kinds = [...(a.strong.size ? a.strong : a.weak)].sort(byKind);
    const label = [...a.labels].sort(cmpStr).join(LABEL_SEP);
    const ex = foldExercised(a.ex, a.sources.has('observed'), true);
    return {
      from: a.from, to: a.to, kind: kinds[0]!, ...(kinds.length > 1 ? { kinds } : {}),
      ...(label ? { label } : {}), ...(a.counted ? { count: a.count } : {}), ...(ex !== undefined ? { exercised: ex } : {}), sources: sortSources([...a.sources]),
    };
  }
}

/** Several records' `exercised`, as one: ran if the result is observed and anyone could tell; not exercised only if
 *  nothing ran and (`strict`) every record could tell (a relationship rolled up from a call nobody could watch stays
 *  unknown), or (not strict) at least one could (a node: its watchable parts all idle). */
function foldExercised(xs: (boolean | undefined)[], observed: boolean, strict: boolean): boolean | undefined {
  const known = xs.filter((x): x is boolean => x !== undefined);
  if (!known.length) return undefined;
  if (observed) return true;
  return strict && known.length < xs.length ? undefined : false;
}

/** One edge per identity. Idempotent; a model with several edges for one pair (a declared `reads` and an
 *  observed `calls` as two edges) comes out with one. */
export function foldEdges(edges: MEdge[]): MEdge[] {
  const f = new EdgeFold();
  for (const e of edges) f.add(e);
  return f.edges();
}
/** The model with one edge per identity (see `foldEdges`); everything else unchanged. */
export function normalize(m: Model): Model { return { ...m, edges: foldEdges(m.edges ?? []) }; }
/** The relationships (every non-import edge), one per ordered pair: what views draw as wires. */
export function relations(m: Model): MEdge[] { return foldEdges((m.edges ?? []).filter((e) => !isImport(e))); }

/** A recorded call from `caller` to `callee`, as a relationship: which one it confirms, and whether it runs
 *  against that relationship's direction. */
export interface Hop { key: string; from: string; to: string; reversed: boolean }
/** The relationship a recorded call belongs to. Merge counts calls with it and every view that walks
 *  spans (flow replay, trace board) draws with it, so a hop always lands on the wire that was counted:
 *  the caller → callee relationship; else a declared `callee subscribes caller` (a queue delivering to its
 *  subscriber runs against the declared direction); else the caller → callee relationship the merge
 *  creates for an undeclared call. */
export function attributeCall(get: (key: string) => MEdge | undefined, caller: string, callee: string): Hop {
  const fwd = pairKey(caller, callee);
  if (get(fwd)) return { key: fwd, from: caller, to: callee, reversed: false };
  const back = get(pairKey(callee, caller));
  if (back && back.sources.includes('declared') && kindsOf(back).includes('subscribes')) return { key: pairKey(callee, caller), from: callee, to: caller, reversed: true };
  return { key: fwd, from: caller, to: callee, reversed: false };
}

/** What the sources of truth make of a relationship. `entry`: an actor (a flow's entry, outside the code)
 *  was seen calling in, which no annotation needs to declare. `proposed`: only a splice says so (neither
 *  declared nor seen): an intention, not drift. */
/** `extracted`: static analysis found the call in the code (automatic mode), nobody declared it, no recorded run saw it.
 *  `unexercised`: in the code (declared or extracted), and a recording that watched both ends in full never saw it
 *  (the edge's `exercised: false`): not exercised by the recorded runs, which is not the same as not recorded at all. */
export type Verdict = 'confirmed' | 'unseen' | 'unexercised' | 'extracted' | 'undeclared' | 'entry' | 'possible' | 'proposed';
export function verdict(e: MEdge, kindOf: (id: string) => NodeKind | undefined): Verdict {
  const d = e.sources.includes('declared'), x = e.sources.includes('extracted'), o = e.sources.includes('observed');
  if ((d || x) && o) return 'confirmed';
  if ((d || x) && e.exercised === false) return 'unexercised';
  if (d) return 'unseen';
  if (x) return 'extracted';
  if (o) return kindOf(e.from) === 'actor' ? 'entry' : 'undeclared';
  if (e.sources.includes('proposed')) return 'proposed';
  return 'possible';
}
/** How a wire is drawn. */
export type WireStyle = 'solid' | 'dashed' | 'warn' | 'proposed' | 'idle';
/** How every view draws a verdict: seen (solid), not seen (dashed), seen but not declared (warning colour),
 *  proposed by a splice (its own style: an intention, never mistaken for code), not exercised by recorded runs that watched
 *  it (`idle`: dotted and faint, so a partial run never reads as a complete one). */
export const wireStyle = (v: Verdict): WireStyle => (v === 'undeclared' ? 'warn' : v === 'proposed' ? 'proposed' : v === 'unexercised' ? 'idle' : v === 'unseen' || v === 'possible' || v === 'extracted' ? 'dashed' : 'solid');
/** Only a splice says so: a node or relationship whose one source is `proposed`. */
export const isProposed = (x: { sources?: Source[] }) => !!x.sources?.length && x.sources.every((s) => s === 'proposed');

/** The words a wire legend uses: "declared …" for a model whose relationships all come from annotations, "in the code …"
 *  once static analysis (automatic mode) contributes some; `idle` only when a recording watched packages in full. */
export function wireWords(m: Model): { solid: string; dashed: string; warn: string; idle: string | null } {
  const statics = (m.edges ?? []).some((e) => !isImport(e) && e.sources.includes('extracted'));
  const idle = m.coverage?.length ? `not exercised by the recorded runs${Math.min(...m.coverage.map((c) => c.sample ?? 1)) < 1 ? ' (sampled)' : ''}` : null;
  return statics
    ? { solid: 'in the code and seen running', dashed: 'in the code, not seen running', warn: 'seen running, not in the code', idle }
    : { solid: 'declared and seen running', dashed: 'declared, not seen', warn: 'seen, not declared', idle };
}

/** A view's relationships, one per ordered pair, each with its verdict and style: the wires to draw. */
export interface Wire { key: string; from: string; to: string; edge: MEdge; kinds: EdgeKind[]; count: number; verdict: Verdict; style: WireStyle; decl: boolean; seen: boolean }
export function wiresOf(m: Model, keep?: (id: string) => boolean): Wire[] {
  const kind = new Map(m.nodes.map((n) => [n.id, n.kind]));
  return relations(m).filter((e) => e.from !== e.to && (!keep || (keep(e.from) && keep(e.to)))).map((e) => {
    const v = verdict(e, (id) => kind.get(id));
    return { key: pairKey(e.from, e.to), from: e.from, to: e.to, edge: e, kinds: kindsOf(e), count: e.count ?? 0, verdict: v, style: wireStyle(v), decl: e.sources.includes('declared'), seen: e.sources.includes('observed') };
  });
}

// ================================================================== merge

/** How much a node record knows: a declaration beats an extracted module; a real node beats an
 *  `external` stub; a code ref and captured code add a little. */
function richness(n: MNode) {
  return (n.sources?.includes('declared') ? 8 : 0) + (n.kind !== 'external' ? 4 : 0) + (n.ref ? 2 : 0) + (n.code?.text ? 1 : 0);
}
/** Key order doesn't matter: a canonical string for tie-breaks, so merge doesn't depend on fragment order. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** All records of one node id, folded in a canonical order (richest first, ties by content), so the result
 *  is the same whatever order the fragments came in: each field from the richest record that has it,
 *  sources and tags as unions, the longest captured code. */
function foldNode(records: MNode[], carry: (c: MCheck) => void): MNode {
  const rs = records.map((r) => ({ r, k: canon(r) })).sort((a, b) => richness(b.r) - richness(a.r) || cmpStr(a.k, b.k)).map((x) => x.r);
  const m = {} as Record<string, unknown>;
  for (const r of rs) for (const [k, v] of Object.entries(r)) if (m[k] === undefined && v !== undefined && v !== null) m[k] = v;
  const n = m as unknown as MNode;
  n.sources = sortSources(uniq(rs.flatMap((r) => r.sources ?? [])));
  const tags = uniq(rs.flatMap((r) => r.tags ?? [])).sort(cmpStr);
  if (tags.length) n.tags = tags; else delete n.tags;
  // declared metadata: one category; the richest declaration's wins, and a different one is a warning
  const cats = uniq(rs.map((r) => r.category).filter((c): c is string => !!c));
  if (cats.length) n.category = cats[0]!; else delete n.category;
  if (cats.length > 1)
    carry({ level: 'warn', code: 'category-conflict', subject: n.id, message: `${n.id} is declared with category ${cats.map((c) => `"${c}"`).join(' and ')}; keeping "${cats[0]}".` });
  // static scan and runtime both capture a declaration's source: keep the longer one, once
  const code = rs.map((r) => r.code).filter((c): c is MCode => !!c?.text).sort((a, b) => b.text.length - a.text.length || cmpStr(canon(a), canon(b)))[0];
  if (code) n.code = code; else delete n.code;
  return n;
}

/** A fragment as read from disk. Format version 1 is written as `"karyo": 1`. */
export type Fragment = Partial<Model>;

/** The format version a fragment or model declares (its `karyo` key). */
export function formatVersion(f: Fragment): unknown { return f.karyo; }

/** Checks a fragment brings with it (the SDKs' own findings, e.g. `directive-invalid`), and the merge's
 *  own (`category-conflict`, `edge-kind`): kept in the model next to the reconcile checks. */
export const FRAGMENT_CHECKS = new Set(['directive-invalid', 'category-conflict', 'edge-kind', 'monitor-capped']);
/** Checks a build adds from outside the fragments and `check` keeps: tours (`tour-*`) and the curation file (`curation-*`). */
export const isBuildCheck = (c: MCheck) => c.code.startsWith('tour-') || c.code.startsWith('curation-');

/** What `merge` can do besides folding fragments: apply a curation file (src/model/curation.ts) before reconciling. */
export interface MergeOpts { curate?: (m: Model) => MCheck[] }

/** Merge fragments (from any number of producers and languages) into one model, then reconcile, then
 *  check the invariants. The result doesn't depend on the order of the fragments (up to array order). */
export function merge(frags: Fragment[], project?: string, opts: MergeOpts = {}): Model {
  const records = new Map<string, MNode[]>();
  const carried: MCheck[] = [];
  const carry = (c: MCheck) => { if (!carried.some((x) => x.code === c.code && x.subject === c.subject && x.message === c.message)) carried.push(c); };
  const edges = new EdgeFold();
  const traces = new Map<string, { flows: MFlow[]; spans: Map<string, MSpan> }>();
  const producers: NonNullable<Model['producers']> = [];
  const projects = new Set<string>();
  const coverage = new Map<string, MCoverage>();

  for (const f of frags) {
    const v = formatVersion(f);
    if (v !== undefined && v !== 1) throw new Error(`karyo: unsupported fragment format version ${JSON.stringify(v)} (expected "karyo": 1)`);
    producers.push(...(f.producers ?? []));
    if (f.project) projects.add(f.project);
    for (const c of f.checks ?? []) carry(c);
    for (const c of f.coverage ?? []) { const k = canon({ ...c, scope: [...c.scope].sort(cmpStr) }); if (!coverage.has(k)) coverage.set(k, { ...c, scope: [...c.scope].sort(cmpStr) }); }
    for (const n of f.nodes ?? []) (records.get(n.id) ?? records.set(n.id, []).get(n.id)!).push({ ...n, sources: [...(n.sources ?? [])] });
    for (const e of f.edges ?? []) edges.add(e);
    for (const fl of f.flows ?? []) {
      const tr = traces.get(fl.trace) ?? { flows: [] as MFlow[], spans: new Map<string, MSpan>() };
      tr.flows.push(fl);
      // the same span from two fragments: keep one, the same one whatever the order
      for (const s of fl.spans) { const cur = tr.spans.get(s.id); const done = Number(s.end !== undefined) - Number(cur?.end !== undefined); if (!cur || done > 0 || (done === 0 && canon(s) < canon(cur))) tr.spans.set(s.id, s); }
      traces.set(fl.trace, tr);
    }
  }
  project ??= [...projects].sort(cmpStr)[0];
  for (const u of edges.unknownKinds)
    carry({ level: 'warn', code: 'edge-kind', subject: pairKey(u.from, u.to), message: `${u.from} → ${u.to} is declared with kind "${u.kind}", which isn't one of ${RELATION_KINDS.join(', ')}; read as calls.` });

  const nodes = new Map<string, MNode>();
  for (const [id, rs] of records) nodes.set(id, foldNode(rs, carry));

  // ---- flows: one per trace, spans from every process, sorted by start time. Traces are named in
  // start order, so the first recording of a flow keeps its plain id whatever order the fragments came in.
  const built = [...traces].map(([trace, tr]) => {
    const spans = collapseSameNode([...tr.spans.values()].sort((a, b) => a.start - b.start || cmpStr(a.id, b.id)));
    const root = spans.find((s) => !s.parent || !tr.spans.has(s.parent));
    // the flow is named by the process that started the trace: the one owning the root span
    const fls = [...tr.flows].sort((a, b) => cmpStr(canon({ ...a, spans: [] }), canon({ ...b, spans: [] })));
    const owner = fls.find((fl) => root && fl.spans.some((s) => s.id === root.id)) ?? fls[0]!;
    return { trace, spans, root, owner, entry: owner.entry ?? fls.find((fl) => fl.entry)?.entry };
  }).sort((a, b) => (a.root?.start ?? a.spans[0]?.start ?? 0) - (b.root?.start ?? b.spans[0]?.start ?? 0) || cmpStr(a.trace, b.trace));
  const flows: MFlow[] = [];
  const seenIds = new Map<string, number>();
  for (const b of built) {
    let id = b.root?.flow ?? b.owner.id;
    const n = (seenIds.get(id) ?? 0) + 1;
    seenIds.set(id, n);
    if (n > 1) id = `${id}#${n}`;
    flows.push({ id, ...(b.owner.title !== undefined ? { title: b.owner.title } : {}), trace: b.trace, ...(b.entry ? { entry: b.entry } : {}), spans: b.spans });
  }

  // ---- an edge names a node nobody declared (a typo, or a fragment missing from the build): a stub
  // node, so the edge is drawn and `reconcile` reports it (`unknown-node`), never an edge into nothing
  for (const e of edges.edges()) for (const id of [e.from, e.to]) {
    if (nodes.has(id)) continue;
    nodes.set(id, e.kind === 'imports'
      ? { id, kind: 'module', label: id, module: id, sources: ['extracted'] }
      : { id, kind: 'external', label: id, group: id.split('.')[0], sources: [] });
  }

  // ---- observed nodes and relationships, derived from spans
  for (const fl of flows) {
    const ids = new Map(fl.spans.map((s) => [s.id, s]));
    for (const s of fl.spans) {
      const nd = nodes.get(s.node);
      if (nd) { if (!nd.sources.includes('observed')) nd.sources = sortSources([...nd.sources, 'observed']); }
      else nodes.set(s.node, { id: s.node, kind: 'function', label: s.node, ...(s.lang ? { lang: s.lang } : {}), group: s.node.split('.')[0], sources: ['observed'] });
      const caller = s.parent && ids.has(s.parent) ? ids.get(s.parent)!.node : fl.entry;
      if (!caller || caller === s.node) continue;
      if (!nodes.has(caller)) nodes.set(caller, { id: caller, kind: 'actor', label: caller, sources: ['observed'] });
      // one relationship per pair: the call confirms whatever the code declared for it (see attributeCall)
      edges.observe(attributeCall((k) => edges.get(k), caller, s.node));
    }
  }

  const cov = [...coverage.entries()].sort(([a], [b]) => cmpStr(a, b)).map(([, c]) => c);
  const model: Model = { karyo: 1, ...(project ? { project } : {}), producers, nodes: [...nodes.values()].sort((a, b) => cmpStr(a.id, b.id)), edges: edges.edges(), flows, ...(cov.length ? { coverage: cov } : {}) };
  const curated = opts.curate ? opts.curate(model) : [];
  markExercised(model);
  model.checks = [...carried, ...curated, ...reconcile(model)];
  model.checks.push(...invariants(model));
  return model;
}

/** Node kinds a recording can see run (a type may be constructed by code that isn't its own; modules, externals and
 *  actors aren't the recorded code). */
const WATCHABLE: ReadonlySet<NodeKind> = new Set(['function', 'service', 'store', 'queue']);
/** Is a node inside a coverage scope (its module, else its id, is a scope or under one)? */
export function inCoverage(m: Pick<Model, 'coverage'>, n: Pick<MNode, 'id' | 'module'>): boolean {
  const k = n.module ?? n.id;
  return (m.coverage ?? []).some((c) => c.scope.some((p) => k === p || k.startsWith(`${p}.`) || n.id === p || n.id.startsWith(`${p}.`)));
}
/** After a recorded run that watched whole packages (`coverage`), say for everything in them whether it ran: nodes a
 *  recording can see, and relationships between two of them (`exercised`). Idempotent; nothing without coverage. */
export function markExercised(m: Model): void {
  for (const n of m.nodes) delete n.exercised;
  for (const e of m.edges) delete e.exercised;
  if (!m.coverage?.length) return;
  const watched = new Set(m.nodes.filter((n) => WATCHABLE.has(n.kind) && !isProposed(n) && inCoverage(m, n)).map((n) => n.id));
  for (const n of m.nodes) if (watched.has(n.id)) n.exercised = n.sources.includes('observed');
  for (const e of m.edges) if (!isImport(e) && !isProposed(e) && watched.has(e.from) && watched.has(e.to)) e.exercised = e.sources.includes('observed');
}

/** A span nested directly in a span of the same node (e.g. a manual span inside a decorated function) adds nothing: fold it into its parent. */
export function collapseSameNode(spans: MSpan[]): MSpan[] {
  const ids = new Map(spans.map((s) => [s.id, s]));
  const alias = new Map<string, string>();
  for (const s of spans) if (s.parent && ids.get(s.parent)?.node === s.node) alias.set(s.id, alias.get(s.parent) ?? s.parent);
  return spans.filter((s) => !alias.has(s.id)).map((s) => (s.parent && alias.has(s.parent) ? { ...s, parent: alias.get(s.parent)! } : s));
}

// ================================================================== fold view

/** A model as views draw it: every node with `fold` is drawn as part of its nearest unfolded ancestor (`parent`), so
 *  its relationships, recorded calls and checks roll up onto that node, one wire per pair as always. `parts` lists what
 *  each shown node folds (its own details can list them); `rep` maps any id to the node that shows it. The result is a
 *  valid model (the invariants hold). A node whose parent isn't in the model stays its own card. */
export interface FoldedView { model: Model; parts: Map<string, MNode[]>; rep: (id: string) => string }
export function foldView(m: Model): FoldedView {
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, string>();
  const rep = (id: string): string => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    let cur = id;
    const seen = new Set<string>();
    for (let n = byId.get(cur); n?.fold && n.parent && n.parent !== cur && byId.get(n.parent)?.kind !== 'module' && byId.has(n.parent) && !seen.has(cur); n = byId.get(cur)) { seen.add(cur); cur = n.parent; }
    memo.set(id, cur);
    return cur;
  };
  if (!m.nodes.some((n) => n.fold && n.parent && byId.has(n.parent) && byId.get(n.parent)!.kind !== 'module')) return { model: m, parts: new Map(), rep: (id) => id };
  const parts = new Map<string, MNode[]>();
  for (const n of m.nodes) { const r = rep(n.id); if (r !== n.id) (parts.get(r) ?? parts.set(r, []).get(r)!).push(n); }
  const nodes = m.nodes.filter((n) => rep(n.id) === n.id).map((n) => {
    const ps = parts.get(n.id);
    if (!ps) return n;
    const sources = sortSources(uniq([n, ...ps].flatMap((x) => x.sources ?? [])));
    const ex = foldExercised([n, ...ps].map((x) => x.exercised), sources.includes('observed'), false);
    const out: MNode = { ...n, sources };
    if (ex === undefined) delete out.exercised; else out.exercised = ex;
    return out;
  });
  const fold = new EdgeFold();
  for (const e of m.edges ?? []) {
    if (isImport(e)) { fold.add(e); continue; }
    const a = rep(e.from), b = rep(e.to);
    if (a !== b) fold.add({ ...e, from: a, to: b });
  }
  const flows = m.flows.map((f) => ({ ...f, spans: collapseSameNode(f.spans.map((s) => (rep(s.node) === s.node ? s : { ...s, node: rep(s.node) }))) }));
  const subject = (x: string) => { const p = parsePairKey(x); if (!p) return byId.has(x) ? rep(x) : x; const a = rep(p.from), b = rep(p.to); return a === b ? a : pairKey(a, b); };
  const checks = (m.checks ?? []).map((c) => (c.subject ? { ...c, subject: subject(c.subject) } : c));
  return { model: { ...m, nodes, edges: fold.edges(), flows, checks }, parts, rep };
}

// ================================================================== reconcile

/** Compare the three sources of truth. Everything is a warning or a note: nothing here fails a build.
 *  Works on any model, including one with several edges for one pair. Proposed nodes and
 *  relationships (a splice's, `isProposed`) are intentions, not code: they are never checked for drift. */
export function reconcile(m: Model): MCheck[] {
  const out: MCheck[] = [];
  const nodes = new Map(m.nodes.map((n) => [n.id, n]));
  // in pair order, so which relationship names a check never depends on the order edges were merged in
  const rel = relations(m).filter((e) => !isProposed(e)).sort((a, b) => cmpStr(pairKey(a.from, a.to), pairKey(b.from, b.to)));
  const importEdges = (m.edges ?? []).filter(isImport);
  const imports = new Set(importEdges.map((e) => pairKey(e.from, e.to)));
  const lbl = (id: string) => nodes.get(id)?.label ?? id;
  const kindOf = (id: string) => nodes.get(id)?.kind;
  const statics = rel.some((e) => e.sources.includes('extracted'));

  for (const e of rel) {
    const p = pairKey(e.from, e.to), v = verdict(e, kindOf);
    if (v === 'undeclared')
      out.push({ level: 'warn', code: 'undeclared-call', subject: p, message: `${lbl(e.from)} called ${lbl(e.to)} in a recorded run, but no annotation declares it${statics ? ' and static analysis didn\'t find it' : ''}.` });
    if ((v === 'unseen' || v === 'unexercised') && e.sources.includes('declared') && m.flows.length)
      out.push({ level: 'info', code: 'unobserved-call', subject: p, message: `${lbl(e.from)} → ${lbl(e.to)} is declared but no recorded run exercised it.` });
  }
  // coverage: what the recordings that watched whole packages exercised, in numbers (the marks are on the nodes and edges)
  if (m.coverage?.length) {
    const ns = m.nodes.filter((n) => n.exercised !== undefined), es = rel.filter((e) => e.exercised !== undefined);
    const ran = ns.filter((n) => n.exercised).length, went = es.filter((e) => e.exercised).length;
    const sample = Math.min(...m.coverage.map((c) => c.sample ?? 1));
    out.push({ level: 'info', code: 'coverage', subject: 'coverage', message: `recorded runs watching ${uniq(m.coverage.flatMap((c) => c.scope)).sort(cmpStr).join(', ')}${sample < 1 ? ` (sampled: ${+(sample * 100).toFixed(2)}% of flows)` : ''} exercised ${ran} of ${ns.length} nodes and ${went} of ${es.length} relationships; ${ns.length - ran} node(s) and ${es.length - went} relationship(s) never ran (not exercised).` });
  }
  // imports: only checkable between two modules of the same language that both have import data.
  // A module that imports both ends (a composition root: `app.py` building a server from its
  // parts) makes an indirect call plausible — dependency injection, plugin registries — so that
  // is a note, not a warning.
  const scanned = new Set(importEdges.flatMap((e) => [e.from, e.to]));
  const importsOf = new Map<string, Set<string>>();
  for (const e of importEdges) (importsOf.get(e.from) ?? importsOf.set(e.from, new Set()).get(e.from)!).add(e.to);
  const checked = new Set<string>();
  for (const e of rel) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a?.module || !b?.module || a.module === b.module || a.lang !== b.lang || !scanned.has(a.module)) continue;
    const p = pairKey(a.module, b.module);
    if (checked.has(p) || imports.has(p)) continue;
    checked.add(p);
    const root = [...importsOf].filter(([, to]) => to.has(a.module!) && to.has(b.module!)).map(([r]) => r).sort(cmpStr)[0];
    if (root)
      out.push({ level: 'info', code: 'wired', subject: pairKey(e.from, e.to), message: `${lbl(e.from)} → ${lbl(e.to)} is indirect: ${a.module} doesn't import ${b.module}; ${root} wires them together.` });
    else
      out.push({ level: 'warn', code: 'no-import', subject: pairKey(e.from, e.to), message: `${lbl(e.from)} → ${lbl(e.to)}, but module ${a.module} never imports ${b.module}.` });
  }
  for (const n of m.nodes) {
    const src = n.sources ?? [];
    if (isProposed(n)) continue;
    if (!src.length) {
      const by = rel.find((e) => e.from === n.id || e.to === n.id);
      out.push({ level: 'warn', code: 'unknown-node', subject: n.id, message: `${by ? `${by.from} → ${by.to}` : 'An edge'} names ${n.id}, which nobody declared.` });
    } else if (src.length === 1 && src[0] === 'observed')
      out.push({ level: 'warn', code: 'unknown-node', subject: n.id, message: n.kind === 'actor' ? `A recorded flow starts from ${n.id}, which nobody declared (declare it with karyo:external kind=actor, or fix the flow's entry).` : `A recorded run reached ${n.id}, which nobody declared.` });
    if (n.kind !== 'module' && src.includes('declared') && !(m.edges ?? []).some((e) => !isProposed(e) && (e.from === n.id || e.to === n.id)))
      out.push({ level: 'info', code: 'orphan', subject: n.id, message: `${lbl(n.id)} is declared but connected to nothing.` });
  }
  // tags and categories are declared words: two spellings of one word are two legend entries
  const real = m.nodes.filter((n) => !isProposed(n));
  for (const [what, words] of [['category', real.map((n) => n.category)], ['tag', real.flatMap((n) => n.tags ?? [])]] as const) {
    const by = new Map<string, Set<string>>();
    for (const w of words) if (w) (by.get(nameFold(w)) ?? by.set(nameFold(w), new Set()).get(nameFold(w))!).add(w);
    for (const [k, s] of by) if (s.size > 1)
      out.push({ level: 'warn', code: 'name-variant', subject: `${what}:${k}`, message: `the ${what} ${[...s].sort(cmpStr).map((x) => `"${x}"`).join(' and ')} ${s.size > 2 ? 'are' : 'are two'} spellings of one word; the legend shows them apart. Use one.` });
  }
  return out;
}

// ================================================================== invariants

/** What must hold of every merged model. A violation is an `error`: either two things in the code claim
 *  one identity (`id-conflict`: ids that differ only in case, a node named like a module) and the picture
 *  can't be drawn truthfully, or the engine broke its own rules (`invariant`). Builds and checks fail on
 *  both, with or without --strict: unlike drift, there is no honest way to draw them.
 *  A spliced model (src/model/splice.ts) passes too: proposed nodes and relationships follow the same identity
 *  rules, need no `unknown-node` check, are never recorded (no span of a proposed node, no count on a proposed
 *  relationship) and never import. */
export function invariants(m: Model): MCheck[] {
  const out: MCheck[] = [];
  const bug = (subject: string, message: string) => out.push({ level: 'error', code: 'invariant', subject, message: `engine invariant broken: ${message}` });
  const conflict = (subject: string, message: string) => out.push({ level: 'error', code: 'id-conflict', subject, message });
  const nodes = new Map<string, MNode>();
  const folded = new Map<string, string>();
  for (const n of m.nodes) {
    if (nodes.has(n.id)) bug(n.id, `node ${n.id} appears twice in the model.`);
    nodes.set(n.id, n);
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) conflict(String(n.id), `node id ${JSON.stringify(n.id)} isn't a valid id (letters, digits and _ . : / - only, no spaces): it can't be told apart reliably.`);
    const k = idFold(String(n.id)), other = folded.get(k);
    if (other !== undefined && other !== n.id) conflict(n.id, `node ids "${other}" and "${n.id}" differ only in case or punctuation: one name, two nodes. Use one spelling everywhere (directives, spans, flow entries).`);
    else folded.set(k, n.id);
    if (n.tags && (n.tags.some((t, i) => i > 0 && !(n.tags![i - 1]! < t)))) bug(n.id, `${n.id}'s tags aren't a sorted set.`);
    if (n.sources?.includes('proposed') && !isProposed(n)) bug(n.id, `${n.id} mixes proposed with ${n.sources.filter((s) => s !== 'proposed').join(', ')}: a proposal is either real or not.`);
    if (isProposed(n) && n.kind === 'module') bug(n.id, `${n.id} is a proposed module: splices propose nodes, the import scan finds modules.`);
    if (n.exercised !== undefined && n.exercised !== !!n.sources?.includes('observed')) bug(n.id, `${n.id} is marked ${n.exercised ? 'exercised' : 'not exercised'}, but its sources say it ${n.sources?.includes('observed') ? 'ran' : 'never ran'}.`);
  }
  const keys = new Map<string, number>();
  for (const e of m.edges ?? []) {
    const k = edgeKey(e);
    keys.set(k, (keys.get(k) ?? 0) + 1);
    if (!KIND_RANK.has(e.kind)) bug(k, `${k} has kind "${e.kind}".`);
    const ks = kindsOf(e);
    if (e.sources?.includes('proposed') && (!isProposed(e) || isImport(e) || typeof e.count === 'number'))
      bug(k, `${k} is proposed but also ${isImport(e) ? 'an import' : typeof e.count === 'number' ? 'counted by recorded runs' : e.sources.filter((s) => s !== 'proposed').join(', ')}: a proposal is an intention, never recorded or scanned.`);
    if (e.exercised !== undefined && (isImport(e) || e.exercised !== !!e.sources?.includes('observed'))) bug(k, `${k} is marked ${e.exercised ? 'exercised' : 'not exercised'}, but ${isImport(e) ? 'it is an import' : `its sources say it was${e.sources?.includes('observed') ? '' : ' never'} seen`}.`);
    if (e.kinds && (e.kinds.length < 2 || e.kinds[0] !== e.kind || e.kinds.some((x, i) => i > 0 && byKind(e.kinds![i - 1]!, x) >= 0) || (e.kind === 'imports') !== ks.includes('imports')))
      bug(k, `${k} has kinds ${JSON.stringify(e.kinds)} with kind "${e.kind}" (kinds must be sorted, unique, start with kind, and never mix imports with relationships).`);
    for (const id of [e.from, e.to]) {
      const n = nodes.get(id);
      if (!n) { bug(k, `${k} ends at ${id}, which isn't a node.`); continue; }
      if (isImport(e) && n.kind !== 'module')
        conflict(id, `"${id}" is the name of a module (the import scan has imports of it) and of a ${n.kind} node: one id, two things. Rename the node (node ids and module names share one namespace).`);
      if (!isImport(e) && n.kind === 'module')
        conflict(k, `${e.from} → ${e.to} (${ks.join(', ')}) ends at "${id}", which is a module from the import scan, not a declared node: name the node, or declare one with that id.`);
    }
  }
  for (const [k, c] of keys) if (c > 1) bug(k, `${c} edges share the identity ${k}; one relationship must be one edge (fold its kinds, sources and counts).`);
  // spans: every recorded call is attributed to a relationship that says it was observed
  const rel = new Map(relations(m).map((e) => [pairKey(e.from, e.to), e]));
  const hops = new Map<string, number>();
  const flowIds = new Set<string>();
  for (const fl of m.flows ?? []) {
    if (flowIds.has(fl.id)) bug(`flow:${fl.id}`, `two flows are called "${fl.id}".`);
    flowIds.add(fl.id);
    if (fl.entry !== undefined && !nodes.has(fl.entry)) bug(`flow:${fl.id}`, `flow ${fl.id} enters from ${fl.entry}, which isn't a node.`);
    const ids = new Map<string, MSpan>();
    for (const s of fl.spans) { if (ids.has(s.id)) bug(`flow:${fl.id}`, `flow ${fl.id} has span ${s.id} twice.`); ids.set(s.id, s); }
    for (const s of fl.spans) {
      if (!nodes.has(s.node)) { bug(`flow:${fl.id}`, `span ${s.id} of flow ${fl.id} is of ${s.node}, which isn't a node.`); continue; }
      if (isProposed(nodes.get(s.node)!)) bug(`flow:${fl.id}`, `span ${s.id} of flow ${fl.id} records ${s.node}, which is only proposed.`);
      const caller = s.parent && ids.has(s.parent) ? ids.get(s.parent)!.node : fl.entry;
      if (!caller || caller === s.node) continue;
      const h = attributeCall((key) => rel.get(key), caller, s.node);
      const e = rel.get(h.key);
      if (!e || !e.sources.includes('observed')) bug(h.key, `the recorded call ${caller} → ${s.node} (flow ${fl.id}) isn't an observed relationship.`);
      else hops.set(h.key, (hops.get(h.key) ?? 0) + 1);
    }
  }
  for (const [k, n] of hops) { const c = rel.get(k)?.count ?? 0; if (c < n) bug(k, `${k} counts ${c} recorded calls, but the flows hold ${n}.`); }
  // every node nobody declared is reported, so it never passes silently
  const unknown = new Set((m.checks ?? []).filter((c) => c.code === 'unknown-node').map((c) => c.subject));
  for (const n of m.nodes) {
    const src = n.sources ?? [];
    if ((!src.length || (src.length === 1 && src[0] === 'observed')) && !unknown.has(n.id)) bug(n.id, `${n.id} was declared by nobody, and no unknown-node check says so.`);
  }
  // one report per problem (an id in a hundred imports is one conflict)
  return out.filter((c, i) => out.findIndex((x) => x.code === c.code && x.subject === c.subject) === i);
}

/** Checks touching a node or a relationship (for badges): the node's own, and every check about a pair it is in. */
export function checksFor(m: Model, subject: string): MCheck[] {
  return (m.checks ?? []).filter((c) => {
    if (!c.subject) return false;
    if (c.subject === subject) return true;
    if (/^tours?:/.test(c.subject)) return false;
    const p = parsePairKey(c.subject);
    return !!p && (p.from === subject || p.to === subject);
  });
}
