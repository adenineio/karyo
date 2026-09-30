// Automatic mode in the model (docs/MODEL.md "Automatic mode", "Curation", "Coverage", "Fold"): extracted relationships
// and their verdicts, a directive overriding an automatic node, curation (renames, groups, top / fold, hide, unresolved
// entries), not-exercised marks after a recording that watched whole packages, and the fold view. The invariants hold
// throughout, also over random models (property test at the end).
import { describe, expect, test } from 'bun:test';
import { foldView, invariants, merge, normalize, pairKey, reconcile, relations, wiresOf, wireStyle, type Fragment, type MCheck, type Model, type MNode } from '../src/model/model';
import { applyCuration, groupLabel, selector, validateCuration, type Curation } from '../src/model/curation';
import { modelLegend } from '../src/model/legend';
import { layout } from '../src/model/scenes';

// ------------------------------------------------------------------ fixtures: what the Python SDK writes

const node = (id: string, kind: MNode['kind'], extra: Partial<MNode> = {}): MNode => ({ id, kind, label: id.split('.').pop(), module: id.split('.').slice(0, 2).join('.'), lang: 'python', ref: { file: 'orders/x.py', line: 1 }, sources: ['extracted'], ...extra });

/** `python -m karyo scan --auto orders`: types, functions, methods folded into their class, static calls. */
const scan = (): Fragment => ({
  karyo: 1, producers: [{ name: 'karyo-py scan', lang: 'python' }],
  nodes: [
    { id: 'orders', kind: 'module', module: 'orders', sources: ['extracted'] },
    { id: 'orders.api', kind: 'module', module: 'orders.api', sources: ['extracted'] },
    { id: 'orders.db', kind: 'module', module: 'orders.db', sources: ['extracted'] },
    node('orders.api.checkout', 'function', { group: 'orders' }),
    node('orders.api.refund', 'function', { group: 'orders' }),
    node('orders.db.Store', 'type', { group: 'orders', module: 'orders.db' }),
    node('orders.db.Store.get', 'function', { group: 'orders', module: 'orders.db', parent: 'orders.db.Store', fold: true }),
    node('orders.db.Store.put', 'function', { group: 'orders', module: 'orders.db', parent: 'orders.db.Store', fold: true }),
    node('orders.db.Store.purge', 'function', { group: 'orders', module: 'orders.db', parent: 'orders.db.Store', fold: true }),
    node('orders.db.helper', 'function', { group: 'orders', module: 'orders.db' }),
  ],
  edges: [
    { from: 'orders.api', to: 'orders.db', kind: 'imports', sources: ['extracted'] },
    { from: 'orders.api.checkout', to: 'orders.db.Store', kind: 'calls', sources: ['extracted'] },
    { from: 'orders.api.checkout', to: 'orders.db.Store.get', kind: 'calls', sources: ['extracted'] },
    { from: 'orders.api.checkout', to: 'orders.db.Store.put', kind: 'calls', sources: ['extracted'] },
    { from: 'orders.api.refund', to: 'orders.db.Store.purge', kind: 'calls', sources: ['extracted'] },
    { from: 'orders.db.Store.get', to: 'orders.db.helper', kind: 'calls', sources: ['extracted'] },
  ],
  flows: [],
});

let spanNo = 0;
const span = (node: string, parent: string | null, extra = {}) => ({ id: `s${++spanNo}`, parent, node, label: `${node.split('.').pop()}()`, start: 1000 + spanNo, end: 2000 + spanNo, status: 'ok' as const, lang: 'python', ...extra });

/** `python -m karyo record --monitor -- pytest`: checkout ran (get, put, helper); refund and purge never did. */
function monitored(extra: Partial<Fragment> = {}): Fragment {
  const root = span('orders.api.checkout', null, { flow: 'test_checkout' });
  const get = span('orders.db.Store.get', root.id);
  return {
    karyo: 1, producers: [{ name: 'karyo-py', lang: 'python' }],
    nodes: [{ id: 'orders.api.checkout', kind: 'function', sources: ['observed'] }, { id: 'orders.db.Store.get', kind: 'function', sources: ['observed'] }],
    edges: [],
    flows: [{ id: 'test_checkout', trace: 't1', spans: [root, span('orders.db.Store', root.id), get, span('orders.db.helper', get.id), span('orders.db.Store.put', root.id), span('orders.db.Store.get', root.id)] }],
    coverage: [{ scope: ['orders'], by: 'karyo-py monitor' }],
    ...extra,
  } as Fragment;
}

const errors = (m: Model) => [...invariants(m), ...(m.checks ?? []).filter((c) => c.level === 'error')].map((c) => c.message);
const edge = (m: Model, a: string, b: string) => relations(m).find((e) => e.from === a && e.to === b);
const wire = (m: Model, a: string, b: string) => wiresOf(m).find((w) => w.key === pairKey(a, b));

// ------------------------------------------------------------------ static relationships

describe('extracted relationships', () => {
  test('a static call nobody declared or saw is `extracted`: in the code, drawn dashed, never a warning', () => {
    const m = merge([scan()]);
    expect(errors(m)).toEqual([]);
    const w = wire(m, 'orders.api.checkout', 'orders.db.Store.get')!;
    expect([w.verdict, w.style, w.decl, w.seen]).toEqual(['extracted', 'dashed', false, false]);
    expect((m.checks ?? []).filter((c) => c.level !== 'info')).toEqual([]);
  });

  test('a static call confirms a declared relationship: sources add up, kinds stay the declared ones', () => {
    const declared: Fragment = { karyo: 1, nodes: [{ id: 'orders.api.checkout', kind: 'service', label: 'Checkout', sources: ['declared'] }, { id: 'orders.db.Store', kind: 'store', sources: ['declared'] }],
      edges: [{ from: 'orders.api.checkout', to: 'orders.db.Store', kind: 'writes', sources: ['declared'] }], flows: [] };
    const m = merge([scan(), declared]);
    expect(errors(m)).toEqual([]);
    const e = edge(m, 'orders.api.checkout', 'orders.db.Store')!;
    expect([e.kind, e.kinds, e.sources]).toEqual(['writes', undefined, ['declared', 'extracted']]);
    // the directive's node wins over the automatic one: its kind and label, both sources
    const n = m.nodes.find((x) => x.id === 'orders.api.checkout')!;
    expect([n.kind, n.label, n.sources]).toEqual(['service', 'Checkout', ['declared', 'extracted']]);
  });

  test('a recorded call static analysis missed is `undeclared`, and the check says static analysis didn\'t find it', () => {
    const f = monitored();
    f.flows![0]!.spans.push(span('orders.api.refund', 's1'));      // checkout → refund: not in the static graph
    const m = merge([scan(), f]);
    expect(wire(m, 'orders.api.checkout', 'orders.api.refund')!.verdict).toBe('undeclared');
    expect(m.checks!.find((c) => c.code === 'undeclared-call')!.message).toContain("static analysis didn't find it");
  });
});

// ------------------------------------------------------------------ coverage: not exercised

describe('coverage', () => {
  test('after a recording that watched the package, what never ran is marked not exercised', () => {
    const m = merge([scan(), monitored()]);
    expect(errors(m)).toEqual([]);
    const ex = Object.fromEntries(m.nodes.filter((n) => n.exercised !== undefined).map((n) => [n.id, n.exercised]));
    // functions only: a type may be constructed by code that isn't its own, a module isn't recorded code
    expect(ex).toEqual({ 'orders.api.checkout': true, 'orders.api.refund': false, 'orders.db.Store.get': true, 'orders.db.Store.put': true, 'orders.db.Store.purge': false, 'orders.db.helper': true });
    expect(wire(m, 'orders.api.refund', 'orders.db.Store.purge')!.verdict).toBe('unexercised');
    expect(wireStyle('unexercised')).toBe('idle');
    expect(wire(m, 'orders.api.checkout', 'orders.db.Store.get')!.verdict).toBe('confirmed');
    // construction of a type: no mark either way (a dataclass is constructed by code that isn't its own)
    expect(edge(m, 'orders.api.checkout', 'orders.db.Store')!.exercised).toBeUndefined();
    const cov = m.checks!.find((c) => c.code === 'coverage')!;
    expect(cov.message).toContain('exercised 4 of 6 nodes and 3 of 4 relationships');
    // the legend lights them
    const L = layout(m);
    const leg = modelLegend({ nodes: L.nodes, wires: L.wires, warned: new Set(), groupOf: (id) => L.nodes.find((n) => n.id === id)!.group ?? '', groupName: (g) => g, groups: [] });
    expect(leg.derived.find((e) => e.id === 'unexercised')!.members.sort()).toEqual(['orders.api.refund', 'orders.db.Store.purge']);
  });

  test('without coverage nothing is marked, and a sampled recording says so', () => {
    const plain = merge([scan(), monitored({ coverage: [] } as Partial<Fragment>)]);
    expect(plain.nodes.some((n) => n.exercised !== undefined) || plain.edges.some((e) => e.exercised !== undefined)).toBe(false);
    expect(wire(plain, 'orders.api.refund', 'orders.db.Store.purge')!.verdict).toBe('extracted');
    const sampled = merge([scan(), monitored({ coverage: [{ scope: ['orders'], sample: 0.01 }] } as Partial<Fragment>)]);
    expect(sampled.checks!.find((c) => c.code === 'coverage')!.message).toContain('sampled: 1% of flows');
  });

  test('check keeps the marks: normalize and relations carry them', () => {
    const m = merge([scan(), monitored()]);
    expect(normalize(m).edges).toEqual(m.edges);
    expect(invariants(normalize(m))).toEqual([]);
  });
});

// ------------------------------------------------------------------ fold view

describe('fold view', () => {
  test('methods fold into their type: relationships and recorded calls roll up, one wire per pair, invariants hold', () => {
    const m = merge([scan(), monitored()]);
    const v = foldView(m);
    expect(errors(v.model)).toEqual([]);
    expect(v.model.nodes.map((n) => n.id).filter((id) => !id.includes('.') || id.split('.').length > 2).sort())
      .toEqual(['orders', 'orders.api.checkout', 'orders.api.refund', 'orders.db.Store', 'orders.db.helper']);
    expect(v.parts.get('orders.db.Store')!.map((n) => n.id).sort()).toEqual(['orders.db.Store.get', 'orders.db.Store.purge', 'orders.db.Store.put']);
    // checkout → Store rolls up Store(), get, put: counted calls add up; get → helper becomes Store → helper
    const e = edge(v.model, 'orders.api.checkout', 'orders.db.Store')!;
    expect([e.count, e.exercised, e.sources]).toEqual([4, true, ['extracted', 'observed']]);
    expect(edge(v.model, 'orders.db.Store', 'orders.db.helper')!.count).toBe(1);
    // refund → purge rolls up to refund → Store: every constituent could tell, none ran: not exercised
    expect(wire(v.model, 'orders.api.refund', 'orders.db.Store')!.verdict).toBe('unexercised');
    // the type card ran (some of its parts did)
    expect(v.model.nodes.find((n) => n.id === 'orders.db.Store')!.exercised).toBe(true);
    // spans: every call is now a call of the type (siblings stay siblings; hops land on the rolled-up wire)
    expect(v.model.flows[0]!.spans.map((s) => s.node)).toEqual(['orders.api.checkout', 'orders.db.Store', 'orders.db.Store', 'orders.db.helper', 'orders.db.Store', 'orders.db.Store']);
    // checks move with the nodes
    expect(reconcile(v.model).filter((c) => c.level === 'error')).toEqual([]);
  });

  test('a type whose watchable parts never ran is not exercised; one with no watchable part says nothing', () => {
    const idle = merge([scan(), monitored({ nodes: [], flows: [{ id: 'x', trace: 't9', spans: [span('orders.api.refund', null)] }] } as Partial<Fragment>)]);
    const v = foldView(idle);
    expect(v.model.nodes.find((n) => n.id === 'orders.db.Store')!.exercised).toBe(false);
    expect(errors(v.model)).toEqual([]);
    const noParts = merge([{ ...scan(), nodes: scan().nodes!.filter((n) => !n.parent) }, monitored({ nodes: [], flows: [] } as Partial<Fragment>)]);
    expect(foldView(noParts).model.nodes.find((n) => n.id === 'orders.db.Store')!.exercised).toBeUndefined();
  });

  test('nothing folds: the model itself', () => {
    const m = merge([{ ...scan(), nodes: scan().nodes!.map((n) => ({ ...n, fold: undefined })) }]);
    expect(foldView(m).model).toBe(m);
  });
});

// ------------------------------------------------------------------ curation

describe('curation', () => {
  const build = (c: Curation, frags = [scan(), monitored()]) => merge(frags, 'orders', { curate: (m) => applyCuration(m, c) });

  test('renames, categories, tags, groups with nesting, top and fold', () => {
    const m = build({
      karyo: 'curation/1',
      top: ['orders.db.Store.get'],
      fold: ['orders.db.helper'],                                      // no parent: a warning, nothing else
      groups: { storage: { label: 'Storage', parent: 'core', members: ['orders.db.*'] }, core: { label: 'Core' } },
      nodes: { 'orders.api.checkout': { label: 'Checkout', category: 'api', tags: ['entry'] }, 'orders.api.*': { tags: ['api'] } },
    });
    expect(errors(m)).toEqual([]);
    const n = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect([n('orders.api.checkout').label, n('orders.api.checkout').category, n('orders.api.checkout').tags]).toEqual(['Checkout', 'api', ['api', 'entry']]);
    expect(n('orders.db.Store.get').fold).toBeUndefined();
    expect(n('orders.db.Store.put').fold).toBe(true);
    expect(n('orders.db.Store').group).toBe('storage');
    expect(groupLabel(m, 'storage')).toBe('Core / Storage');
    expect(m.checks!.filter((c) => c.code.startsWith('curation-')).map((c) => c.code)).toEqual(['curation-invalid']);
    // the fold view: get is its own card now
    expect(foldView(m).model.nodes.some((x) => x.id === 'orders.db.Store.get')).toBe(true);
    expect(layout(m).groups.find((g) => g.id === 'storage')!.label).toBe('Core / Storage · python');
  });

  test('hide leaves nodes and their relationships out, but keeps what a recorded run reached', () => {
    const m = build({ karyo: 'curation/1', hide: ['orders.api.refund', 'orders.db.helper'] });
    expect(errors(m)).toEqual([]);
    expect(m.nodes.some((x) => x.id === 'orders.api.refund')).toBe(false);
    expect(m.edges.some((e) => e.from === 'orders.api.refund' || e.to === 'orders.api.refund')).toBe(false);
    expect(m.nodes.some((x) => x.id === 'orders.db.helper')).toBe(true);    // it ran: kept, and said
    expect(m.checks!.find((c) => c.code === 'curation-kept')!.subject).toBe('orders.db.helper');
  });

  test('an entry that names nothing is an unresolved warning, with a did-you-mean', () => {
    const m = build({ karyo: 'curation/1', top: ['orders.db.Store.gett'], hide: ['tests.*'], nodes: { 'orders.api.chekout': { label: 'X' } } });
    const un = m.checks!.filter((c) => c.code === 'curation-unresolved');
    expect(un.map((c) => c.subject)).toEqual(['curation:nodes:orders.api.chekout', 'curation:top:orders.db.Store.gett', 'curation:hide:tests.*']);
    expect(un.every((c) => c.level === 'warn')).toBe(true);
    expect(un[0]!.message).toContain('did you mean orders.api.checkout');
    expect(un[1]!.message).toContain('did you mean orders.db.Store.get');
    expect(errors(m)).toEqual([]);
  });

  test('a malformed file or entry is reported and skipped, never applied halfway', () => {
    expect(validateCuration({ karyo: 'curation/2' })[0]!.path).toBe('karyo');
    expect(validateCuration({ karyo: 'curation/1', nodes: { a: { kind: 'widget' } }, groups: { g: { parent: 'h' }, h: { parent: 'g' } }, extra: 1 }).map((i) => i.path).sort())
      .toEqual(['extra', 'groups.g.parent', 'groups.h.parent', 'nodes.a.kind']);
    const m = build({ karyo: 'curation/1', nodes: { 'orders.api.checkout': { kind: 'widget' as never, label: 'Nope' } } });
    expect(m.nodes.find((x) => x.id === 'orders.api.checkout')!.label).toBe('checkout');
    expect(m.checks!.some((c) => c.code === 'curation-invalid')).toBe(true);
  });

  test('selectors: exact ids, and * across dots', () => {
    expect(selector('orders.db.*')('orders.db.Store.get')).toBe(true);
    expect(selector('orders.db.*')('orders.dbx')).toBe(false);
    expect(selector('*._*')('orders.db._raw')).toBe(true);
    expect(selector('orders.api')('orders.api.checkout')).toBe(false);
  });
});

// ------------------------------------------------------------------ property test: invariants over random automatic models

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}

function randomAuto(seed: number): Fragment[] {
  const r = rng(seed);
  const types = ['p.a.T', 'p.b.U', 'q.c.V'];
  const ids: string[] = [...types];
  const nodes: MNode[] = types.map((t) => node(t, 'type'));
  for (const t of types) for (const m of ['x', 'y']) if (r.chance(0.7)) { ids.push(`${t}.${m}`); nodes.push(node(`${t}.${m}`, 'function', { parent: t, fold: r.chance(0.8) || undefined })); }
  for (const f of ['p.a.f', 'p.b.g', 'q.c.h']) { ids.push(f); nodes.push(node(f, 'function')); }
  if (r.chance(0.3)) nodes.push(node('p.a.T.x.inner', 'function', { parent: 'p.a.T.x', fold: true }));   // a chain (maybe to a missing parent)
  const edges = [];
  for (let k = r.int(12); k > 0; k--) { const a = r.pick(ids), b = r.pick(ids); if (a !== b) edges.push({ from: a, to: b, kind: 'calls' as const, sources: [r.pick(['extracted', 'declared'] as const)] }); }
  const spans: ReturnType<typeof span>[] = [];
  for (let k = r.int(10); k > 0; k--) spans.push(span(r.pick(ids), spans.length && r.chance(0.7) ? r.pick(spans).id : null));
  const frags: Fragment[] = [{ karyo: 1, nodes, edges, flows: [] }];
  frags.push({ karyo: 1, nodes: [], edges: [], flows: spans.length ? [{ id: 'run', trace: `t${seed}`, spans }] : [], ...(r.chance(0.7) ? { coverage: [{ scope: [r.pick(['p', 'q', 'p.a'])] }] } : {}) } as Fragment);
  return frags;
}

test('property: automatic models, with coverage and a random curation, and their fold views keep every invariant', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed * 7);
    const cur: Curation = { karyo: 'curation/1', ...(r.chance(0.5) ? { top: [r.pick(['p.a.T.x', 'p.*', 'q.c.V.y'])] } : {}), ...(r.chance(0.5) ? { hide: [r.pick(['p.b.*', 'q.c.h', 'p.a.T'])] } : {}),
      ...(r.chance(0.5) ? { groups: { g: { members: [r.pick(['p.a.*', 'q.*'])] } } } : {}) };
    const m = merge(randomAuto(seed), undefined, r.chance(0.6) ? { curate: (x) => applyCuration(x, cur) } : {});
    const label = `seed ${seed}`;
    expect(errors(m).map((e) => `${label}: ${e}`)).toEqual([]);
    const v = foldView(m);
    expect(errors(v.model).map((e) => `${label} (folded): ${e}`)).toEqual([]);
    // one wire per pair, and a wire's style is its verdict's
    const ws = wiresOf(v.model);
    expect(new Set(ws.map((w) => w.key)).size).toBe(ws.length);
    for (const w of ws) expect(w.style).toBe(wireStyle(w.verdict));
    // not exercised only where a recording watched: every marked node is in a coverage scope
    for (const n of m.nodes) if (n.exercised !== undefined) expect(m.coverage?.length ?? 0).toBeGreaterThan(0);
    // nothing folded shows as its own card
    for (const n of v.model.nodes) if (n.fold && n.parent) expect(m.nodes.some((x) => x.id === n.parent)).toBe(false);
  }
});

const _unused: MCheck | undefined = undefined;
void _unused;
